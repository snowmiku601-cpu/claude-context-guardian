// Guardian Liquid Overlay — WPF UI (code-built, no XAML).
// .NET Framework 4.8, compiled by scripts/build-overlay.ps1.
//
// Visual: circular transparent always-on-top overlay; percentage centered;
// liquid fill height tracks usage; two seamless repeating wave layers animate
// horizontally on the render thread at a capped 20 FPS; band color animates.
// Hidden => all animation stopped (true ~0 CPU). Tier 0 (remote session) =>
// static fill fallback. All rendering degradation per plan REV 2.1:
//   20 FPS -> 15 FPS -> one wave -> static fill (text/height/color always kept).
//
// State: read-only consumer of Guardian state dir (contract v1) via
// FileSystemWatcher (Created/Changed/Renamed/Deleted/Error = invalidation
// hints only) + 30 s sweep; every hint triggers a debounced full rescan.

using System;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
using Microsoft.Win32; // WorkArea via SystemParameters (no registry use)

namespace GuardianOverlay
{
    public class OverlayConfig
    {
        public double DiameterPx = 150.0;
        public double Opacity = 0.95;
        public bool WaveEnabled = true;
        public double StaleAfterMinutes = 15.0;
        public bool MultiSessionIndicator = true;
        public int Fps = 20;
        public bool OneWave = false;    // degradation step 2
        public bool StaticFill = false; // degradation step 3
        public string StateDir = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".claude", "guardian", "state");

        public static OverlayConfig Load(string path)
        {
            var c = new OverlayConfig();
            try
            {
                if (!System.IO.File.Exists(path)) return c;
                string json = System.IO.File.ReadAllText(path);
                c.DiameterPx = GetNum(json, "diameterPx", c.DiameterPx, 110, 220);
                c.Opacity = GetNum(json, "opacity", c.Opacity, 0.2, 1.0);
                c.WaveEnabled = GetBool(json, "waveEnabled", c.WaveEnabled);
                c.StaleAfterMinutes = GetNum(json, "staleAfterMinutes", c.StaleAfterMinutes, 1, 240);
                c.MultiSessionIndicator = GetBool(json, "multiSessionIndicator", c.MultiSessionIndicator);
                c.Fps = (int)GetNum(json, "fps", c.Fps, 10, 30);
                // Rendering degradation ladder (REV 2.1): fps 20 -> 15/10,
                // two waves -> one, animated wave -> static fill. Measured
                // on real hardware via scripts/measure-overlay.ps1.
                c.OneWave = GetBool(json, "oneWave", c.OneWave);
                c.StaticFill = GetBool(json, "staticFill", c.StaticFill);
                // Measurement/sandbox override (also lets tests point at
                // synthetic state; never used by the installed default).
                var overrideDir = GetString(json, "stateDir");
                if (!string.IsNullOrEmpty(overrideDir)) c.StateDir = overrideDir;
            }
            catch { return new OverlayConfig(); }
            return c;
        }

        private static double GetNum(string json, string key, double dflt, double min, double max)
        {
            var s = ExtractValue(json, key);
            double v;
            if (s == null || !double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return dflt;
            return Math.Max(min, Math.Min(max, v));
        }

        private static bool GetBool(string json, string key, bool dflt)
        {
            var s = ExtractValue(json, key);
            if (s == "true") return true;
            if (s == "false") return false;
            return dflt;
        }

        private static string GetString(string json, string key)
        {
            var s = ExtractValue(json, key);
            return string.IsNullOrEmpty(s) ? null : s;
        }

        private static string ExtractValue(string json, string key)
        {
            int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return null;
            i += key.Length + 2;
            while (i < json.Length && (json[i] == ' ' || json[i] == ':')) i++;
            int end = i;
            while (end < json.Length && json[end] != ',' && json[end] != '}' && json[end] != '\n') end++;
            return json.Substring(i, end - i).Trim().Trim('"');
        }
    }

    public class OverlayApp
    {
        [STAThread]
        public static int Main(string[] args)
        {
            // Single instance: a second launch just exits silently.
            bool createdNew;
            var mutex = new System.Threading.Mutex(true, "ClaudeContextGuardianOverlay", out createdNew);
            if (!createdNew) return 0;

            // Config dir: %APPDATA%\ClaudeContextGuardian by default. For
            // tests/measurement, CCG_CONFIG_DIR env overrides it (the .NET
            // SpecialFolder API ignores APPDATA env redirection, so tests
            // cannot hermetically redirect without this hook).
            string configDir = Environment.GetEnvironmentVariable("CCG_CONFIG_DIR");
            if (string.IsNullOrEmpty(configDir))
            {
                configDir = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "ClaudeContextGuardian");
            }
            System.IO.Directory.CreateDirectory(configDir);
            var cfg = OverlayConfig.Load(System.IO.Path.Combine(configDir, "overlay.config.json"));

            var win = new OverlayWindow(cfg, configDir);
            var app = new Application();
            try
            {
                app.Run(win);
            }
            finally { mutex.ReleaseMutex(); }
            return 0;
        }
    }

    public class OverlayWindow : Window
    {
        private readonly OverlayConfig _cfg;
        private readonly string _configDir;
        private readonly string _positionFile;
        private readonly string _stateDir;
        private readonly TimeSpan _staleAfter;

        // visuals
        private Canvas _root;
        private System.Windows.Shapes.Path _waveBack;    // slower, lighter
        private System.Windows.Shapes.Path _waveFront;   // faster, stronger
        private System.Windows.Shapes.Path _waveFrontSingle; // degradation: one wave
        private Rectangle _staticFill;                   // degradation: static liquid
        private TranslateTransform _waveBackX, _waveFrontX;
        private TranslateTransform _liquidY;
        private TextBlock _pctText;
        private Ellipse _dot;                            // multi-session indicator
        private EllipseGeometry _circleClip;
        private SolidColorBrush _liquidBrush;            // the single animated brush
        private Canvas _liquidLayer;

        // animation state
        private DispatcherTimer _lerpTimer;
        private double _displayedPct;                    // interpolated value
        private bool _awaiting;                          // null pct
        private bool _hasSession;
        private bool _degradedOneWave, _degradedStatic;

        // state watching
        private FileSystemWatcher _fsw;
        private DispatcherTimer _sweepTimer;
        private DispatcherTimer _debounceTimer;
        private bool _hiddenPause;

        private const double WAVELENGTH = 140.0;
        private const double AMP_FRONT = 7.0;
        private const double AMP_BACK = 5.0;

        public OverlayWindow(OverlayConfig cfg, string configDir)
        {
            _cfg = cfg;
            _configDir = configDir;
            _positionFile = System.IO.Path.Combine(configDir, "overlay.position.json");
            _stateDir = cfg.StateDir;
            _staleAfter = TimeSpan.FromMinutes(cfg.StaleAfterMinutes);

            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ShowActivated = false;
            Width = _cfg.DiameterPx;
            Height = _cfg.DiameterPx;
            Opacity = _cfg.Opacity;

            BuildVisuals();
            // Apply measured degradation ladder before first render.
            _degradedOneWave = _cfg.OneWave;
            _degradedStatic = _cfg.StaticFill;
            RestoreOrPlacePosition();
            ApplyDisplay(GuardianLogic.BuildDisplay(_stateDir, DateTime.UtcNow, _staleAfter), true);
            StartStateWatching();

            IsVisibleChanged += (s, e) => SetAnimationPaused(!(bool)e.NewValue);
            StateChanged += (s, e) => SetAnimationPaused(WindowState != WindowState.Normal);
            Closing += (s, e) => StopStateWatching();
        }

        // ------------------------------------------------------------ visuals --

        private void BuildVisuals()
        {
            double d = _cfg.DiameterPx;
            double r = d / 2.0;

            _root = new Canvas { Width = d, Height = d };
            Content = _root;

            // Circle clip: everything liquid is clipped to the circle.
            _circleClip = new EllipseGeometry(new Point(r, r), r - 1, r - 1);

            _liquidLayer = new Canvas { Width = d, Height = d, Clip = _circleClip };

            // Liquid group shifted vertically by pct (lerped).
            var liquidGroup = new Canvas();
            _liquidY = new TranslateTransform(0, d);
            liquidGroup.RenderTransform = _liquidY;

            _liquidBrush = new SolidColorBrush(BandColor(GuardianLogic.MapBand(null)));
            _liquidBrush.Freeze();

            double pathWidth = d + 2 * WAVELENGTH;
            double pathHeight = d * 2; // deep enough to always cover the bottom

            _waveBack = BuildWavePath(pathWidth, pathHeight, AMP_BACK, 0.30);
            _waveFront = BuildWavePath(pathWidth, pathHeight, AMP_FRONT, 0.55);
            _waveFrontSingle = BuildWavePath(pathWidth, pathHeight, AMP_FRONT, 0.55);

            _waveBackX = new TranslateTransform(0, 0);
            _waveFrontX = new TranslateTransform(WAVELENGTH / 3.0, 0);
            _waveBack.RenderTransform = _waveBackX;
            _waveFront.RenderTransform = _waveFrontX;
            _waveFrontSingle.RenderTransform = _waveFrontX;

            liquidGroup.Children.Add(_waveBack);
            liquidGroup.Children.Add(_waveFront);
            liquidGroup.Children.Add(_waveFrontSingle);
            _waveFrontSingle.Visibility = Visibility.Collapsed;

            _staticFill = new Rectangle
            {
                Width = d * 2,
                Height = d * 2,
                Fill = _liquidBrush,
                Visibility = Visibility.Collapsed
            };
            liquidGroup.Children.Add(_staticFill);

            _liquidLayer.Children.Add(liquidGroup);
            _root.Children.Add(_liquidLayer);

            // Multi-session dot (top-right inside the circle).
            _dot = new Ellipse
            {
                Width = 8, Height = 8,
                Fill = new SolidColorBrush(Color.FromArgb(220, 255, 255, 255)),
                Stroke = new SolidColorBrush(Color.FromArgb(120, 0, 0, 0)),
                StrokeThickness = 0.5,
                Visibility = Visibility.Collapsed
            };
            Canvas.SetLeft(_dot, d - 22);
            Canvas.SetTop(_dot, 12);
            _root.Children.Add(_dot);

            // Percentage text: centered, readable over the liquid.
            _pctText = new TextBlock
            {
                Text = "--",
                FontSize = Math.Max(24, d * 0.22),
                FontWeight = FontWeights.SemiBold,
                Foreground = Brushes.White
            };
            _pctText.Effect = null; // no effects: layered-window budget
            var host = new Border
            {
                Child = _pctText,
                Width = d,
                Height = d,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Background = Brushes.Transparent
            };
            host.ChildAlignmentHost();
            _root.Children.Add(host);

            MouseLeftButtonDown += (s, e) =>
            {
                try { DragMove(); } catch { }
            };
            MouseDoubleClick += (s, e) => { /* reserved: future menu */ };
        }

        private System.Windows.Shapes.Path BuildWavePath(double width, double height, double amp, double opacity)
        {
            // One closed PathGeometry: sine top edge across width, straight
            // down to a deep bottom. Periodic in WAVELENGTH => seamless loop.
            var fig = new PathFigure { StartPoint = new Point(0, amp), IsClosed = true };
            var seg = new PolyLineSegment();
            int steps = (int)(width / 6.0); // ~6 px resolution: smooth, cheap
            for (int i = 1; i <= steps; i++)
            {
                double x = width * i / steps;
                double y = amp * Math.Sin(2 * Math.PI * x / WAVELENGTH);
                seg.Points.Add(new Point(x, amp + y));
            }
            fig.Segments.Add(seg);
            fig.Segments.Add(new LineSegment(new Point(width, height), true));
            fig.Segments.Add(new LineSegment(new Point(0, height), true));
            var geo = new PathGeometry();
            geo.Figures.Add(fig);
            geo.Freeze();
            var p = new System.Windows.Shapes.Path
            {
                Data = geo,
                Fill = _liquidBrush,
                Opacity = opacity,
                IsHitTestVisible = false
            };
            return p;
        }

        // --------------------------------------------------------- animation --

        private void StartWaves()
        {
            if (_degradedStatic || !_cfg.WaveEnabled)
            {
                // Static fill mode: no X animation; the liquid body alone.
                _waveBack.Visibility = Visibility.Collapsed;
                _waveFront.Visibility = Visibility.Collapsed;
                _waveFrontSingle.Visibility = Visibility.Collapsed;
                _staticFill.Visibility = Visibility.Visible;
                return;
            }
            var back = new DoubleAnimation(0, -WAVELENGTH, new Duration(TimeSpan.FromSeconds(4.2)))
            { RepeatBehavior = RepeatBehavior.Forever };
            var front = new DoubleAnimation(0, -WAVELENGTH, new Duration(TimeSpan.FromSeconds(2.8)))
            { RepeatBehavior = RepeatBehavior.Forever };
            Timeline.SetDesiredFrameRate(back, _cfg.Fps);
            Timeline.SetDesiredFrameRate(front, _cfg.Fps);
            _waveBackX.BeginAnimation(TranslateTransform.XProperty, back);
            if (!_degradedOneWave)
            {
                _waveFront.Visibility = Visibility.Visible;
                _waveFrontSingle.Visibility = Visibility.Collapsed;
                _waveFrontX.BeginAnimation(TranslateTransform.XProperty, front);
            }
            else
            {
                _waveFront.Visibility = Visibility.Collapsed;
                _waveFrontSingle.Visibility = Visibility.Visible;
                _waveFrontSingle.RenderTransform.BeginAnimation(TranslateTransform.XProperty, front);
            }
            _waveBack.Visibility = _degradedOneWave ? Visibility.Collapsed : Visibility.Visible;
        }

        private void StopWaves()
        {
            _waveBackX.BeginAnimation(TranslateTransform.XProperty, null);
            _waveFrontX.BeginAnimation(TranslateTransform.XProperty, null);
        }

        private void SetAnimationPaused(bool paused)
        {
            _hiddenPause = paused;
            if (paused) { StopWaves(); if (_lerpTimer != null) _lerpTimer.Stop(); }
            else { StartWaves(); if (_lerpTimer != null) _lerpTimer.Start(); }
        }

        private void EnsureLerpTimer()
        {
            if (_lerpTimer != null) return;
            // Background priority: interpolation is cosmetic, it must never
            // compete with the render queue. The timer also self-stops when
            // the displayed value converges (no idle re-render churn).
            _lerpTimer = new DispatcherTimer(DispatcherPriority.Background)
            {
                Interval = TimeSpan.FromMilliseconds(1000.0 / Math.Max(10, _cfg.Fps))
            };
            _lerpTimer.Tick += (s, e) =>
            {
                if (_awaiting || !_hasSession) { _lerpTimer.Stop(); return; }
                double target = _displayedTargetPct;
                // ~3 percentage points per tick: 10-point change settles in
                // well under a second at 20 FPS without overshoot.
                const double maxStep = 3.0;
                double next = GuardianLogic.NextDisplayed(_displayedPct, target, maxStep);
                bool converged = Math.Abs(next - _displayedPct) < 0.0001;
                if (converged) { _lerpTimer.Stop(); return; }
                _displayedPct = next;
                ApplyLiquidGeometry(_displayedPct);
            };
        }

        private double _displayedTargetPct;

        private void ApplyLiquidGeometry(double pct)
        {
            double d = _cfg.DiameterPx;
            double frac = GuardianLogic.HeightFraction(pct);
            double top = d - frac * d;         // liquid surface Y inside circle
            _liquidY.Y = top;
        }

        // -------------------------------------------------------- color bands --

        private static Color BandColor(ContextBand band)
        {
            switch (band)
            {
                case ContextBand.Red: return Color.FromRgb(0xD9, 0x3B, 0x3B);
                case ContextBand.Orange: return Color.FromRgb(0xE2, 0x8A, 0x2B);
                case ContextBand.Yellow: return Color.FromRgb(0xD9, 0xC4, 0x2B);
                case ContextBand.AwaitStale: return Color.FromRgb(0x60, 0x6A, 0x76);
                default: return Color.FromRgb(0x3B, 0xA5, 0x5D);
            }
        }

        private void AnimateBand(ContextBand band)
        {
            var target = BandColor(band);
            var from = _liquidBrush.Color;
            if (from == target) return;
            // C# 5: create the animated brush as a fresh (unfrozen) clone, start
            // a short ColorAnimation, and re-point the frozen-fill visuals.
            var animated = _liquidBrush.Clone();
            animated.Color = from;
            var anim = new ColorAnimation(from, target, new Duration(TimeSpan.FromMilliseconds(300)));
            _liquidBrush = animated;
            _liquidBrush.BeginAnimation(SolidColorBrush.ColorProperty, anim);
            _waveFront.Fill = _liquidBrush;
            _waveBack.Fill = _liquidBrush;
            _waveFrontSingle.Fill = _liquidBrush;
            _staticFill.Fill = _liquidBrush;
        }

        // ----------------------------------------------------------- display --

        private void ApplyDisplay(DisplayState d, bool instant)
        {
            _hasSession = d.HasSession;
            _awaiting = !d.HasSession || d.Pct == null;

            if (_awaiting)
            {
                // HasSession with null pct = "awaiting sample" (e.g. after
                // PostCompact). No session at all = quiet empty glyph.
                _pctText.Text = d.HasSession ? "--" : "–";
                _pctText.Opacity = 0.45;
            }
            else
            {
                _pctText.Text = Math.Round(d.Pct.Value) + "%";
                _pctText.Opacity = 1.0;
                if (instant || _displayedPct == 0.0 && Math.Abs(_displayedTargetPct - d.Pct.Value) > 0.0001)
                {
                    _displayedTargetPct = d.Pct.Value;
                    _displayedPct = d.Pct.Value;
                    ApplyLiquidGeometry(_displayedPct);
                }
                else if (Math.Abs(_displayedTargetPct - d.Pct.Value) > 0.0001)
                {
                    _displayedTargetPct = d.Pct.Value;
                    EnsureLerpTimer();
                    if (!_hiddenPause && !_lerpTimer.IsEnabled) _lerpTimer.Start();
                }
            }

            AnimateBand(d.Band);
            _dot.Visibility = (_cfg.MultiSessionIndicator && d.MultiSession)
                ? Visibility.Visible : Visibility.Collapsed;
        }

        // ------------------------------------------------------ state watching --

        private void StartStateWatching()
        {
            try
            {
                System.IO.Directory.CreateDirectory(_stateDir);
                _fsw = new FileSystemWatcher(_stateDir)
                {
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                    EnableRaisingEvents = true
                };
                _fsw.Created += OnStateEvent;
                _fsw.Changed += OnStateEvent;
                _fsw.Renamed += OnStateEvent;
                _fsw.Deleted += OnStateEvent;
                _fsw.Error += OnStateError;
            }
            catch { _fsw = null; /* sweep covers */ }

            _debounceTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
            _debounceTimer.Tick += (s, e) =>
            {
                _debounceTimer.Stop();
                RefreshDisplay(false);
            };

            _sweepTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
            _sweepTimer.Tick += (s, e) => RefreshDisplay(false);
            _sweepTimer.Start();
        }

        private void OnStateEvent(object sender, EventArgs e)
        {
            // ANY event (Created/Changed/Renamed/Deleted) is only an
            // invalidation hint: debounce then full rescan. Never trust order.
            _debounceTimer.Stop();
            _debounceTimer.Start();
        }

        private void OnStateError(object sender, ErrorEventArgs e)
        {
            // Buffer overflow etc: recover by rescan; sweep also covers.
            _debounceTimer.Stop();
            _debounceTimer.Start();
        }

        private void RefreshDisplay(bool instant)
        {
            try { ApplyDisplay(GuardianLogic.BuildDisplay(_stateDir, DateTime.UtcNow, _staleAfter), instant); }
            catch { /* never crash the overlay on state problems */ }
        }

        private void StopStateWatching()
        {
            try { if (_fsw != null) { _fsw.EnableRaisingEvents = false; _fsw.Dispose(); } } catch { }
            try { if (_sweepTimer != null) _sweepTimer.Stop(); } catch { }
            try { if (_lerpTimer != null) _lerpTimer.Stop(); } catch { }
        }

        // ----------------------------------------------------------- position --

        private void RestoreOrPlacePosition()
        {
            double d = _cfg.DiameterPx;
            var wa = new Rect(SystemParameters.WorkArea.Left, SystemParameters.WorkArea.Top,
                              SystemParameters.WorkArea.Width, SystemParameters.WorkArea.Height);
            double x = wa.Right - d - 16; // first run: bottom-right above taskbar
            double y = wa.Bottom - d - 16;
            try
            {
                if (System.IO.File.Exists(_positionFile))
                {
                    var json = System.IO.File.ReadAllText(_positionFile);
                    double sx, sy;
                    if (TryGetNum(json, "x", out sx) && TryGetNum(json, "y", out sy)) { x = sx; y = sy; }
                }
            }
            catch { }
            // WorkArea clamp + off-screen recovery (MVP reliability).
            if (x < wa.Left) x = wa.Left;
            if (y < wa.Top) y = wa.Top;
            if (x + d > wa.Right) x = Math.Max(wa.Left, wa.Right - d - 16);
            if (y + d > wa.Bottom) y = Math.Max(wa.Top, wa.Bottom - d - 16);
            Left = x;
            Top = y;

            LocationChanged += (s, e) => PersistPosition();
            Closed += (s, e) => PersistPosition();
        }

        private void PersistPosition()
        {
            try
            {
                System.IO.File.WriteAllText(_positionFile,
                    "{\"x\":" + Left.ToString("0.0", CultureInfo.InvariantCulture) +
                    ",\"y\":" + Top.ToString("0.0", CultureInfo.InvariantCulture) + "}\n");
            }
            catch { }
        }

        private static bool TryGetNum(string json, string key, out double value)
        {
            value = 0;
            int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return false;
            i += key.Length + 2;
            while (i < json.Length && (json[i] == ' ' || json[i] == ':')) i++;
            int start = i;
            while (i < json.Length && (char.IsDigit(json[i]) || json[i] == '.' || json[i] == '-')) i++;
            return double.TryParse(json.Substring(start, i - start), NumberStyles.Float,
                CultureInfo.InvariantCulture, out value);
        }
    }

    internal static class CanvasExtensions
    {
        // C# 5: no property initializer support for this pattern; helper keeps
        // the Border's child centered without XAML.
        public static void ChildAlignmentHost(this Border b)
        {
            b.HorizontalAlignment = HorizontalAlignment.Center;
            b.VerticalAlignment = VerticalAlignment.Center;
            var tb = b.Child as TextBlock;
            if (tb != null)
            {
                tb.HorizontalAlignment = HorizontalAlignment.Center;
                tb.VerticalAlignment = VerticalAlignment.Center;
            }
        }
    }
}
