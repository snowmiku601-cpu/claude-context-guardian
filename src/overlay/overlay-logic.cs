// Guardian Overlay — pure logic layer (NO WPF references allowed).
// This file is compiled by scripts/run-tests.ps1 together with tests/test-main.cs
// WITHOUT any WPF assembly references; touching a WPF type here breaks that
// build. It implements the public State Contract v1 (docs/state-contract-v1.md):
//
//   Required fields (exactly three): session_id (string, non-empty),
//   last_pct (number|null, null or finite 0..100), updated_at (ISO-8601).
//   Every other field is optional forward-compatible extension data.
//
// The overlay never reads transcripts, Claude settings, or the network.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

namespace GuardianOverlay
{
    /// <summary>A parsed state sample; null-valued Pct means "awaiting sample".</summary>
    public sealed class StateSample
    {
        public string SessionId;
        public double? Pct;          // null or 0..100
        public DateTime? UpdatedAtUtc;
        public bool Valid;
    }

    public enum ContextBand { AwaitStale = 0, Green, Yellow, Orange, Red }

    /// <summary>Display model derived from the selected session.</summary>
    public sealed class DisplayState
    {
        public bool HasSession;        // a valid, non-stale sample exists
        public double? Pct;            // null => awaiting
        public ContextBand Band;
        public bool MultiSession;      // >=2 non-stale sessions
        public string SessionId;
    }

    public static class GuardianLogic
    {
        /// <summary>A timestamp more than this far ahead of the reader's clock is
        /// implausible (clock skew) and cannot win session selection.</summary>
        public static readonly TimeSpan FutureTolerance = TimeSpan.FromMinutes(5);

        // ------------------------------------------------------------ parse --

        /// <summary>
        /// Tolerant parse of one state file. Returns a sample with Valid=false
        /// for unreadable/malformed/invalid input; never throws.
        /// sharing: callers open the stream with FileShare.ReadWrite|Delete.
        /// </summary>
        public static StateSample ParseState(Stream jsonStream, string fallbackSessionId)
        {
            var s = new StateSample { SessionId = fallbackSessionId, Pct = null, UpdatedAtUtc = null, Valid = false };
            if (jsonStream == null) return s;
            string raw;
            try
            {
                using (var reader = new StreamReader(jsonStream, new UTF8Encoding(false), true, 4096, true))
                {
                    raw = reader.ReadToEnd();
                }
            }
            catch { return s; }

            // BOM tolerance
            if (!string.IsNullOrEmpty(raw) && raw[0] == '﻿') raw = raw.Substring(1);

            ContractDto dto;
            bool pctPresent = false;
            double pctRaw = 0.0;
            try
            {
                // Parse the raw JSON minimally to detect last_pct presence vs
                // null/missing (DataContract cannot distinguish null from
                // missing on value types). This scan is strict-shape only.
                pctPresent = RawJsonScan.TryExtractLastPct(raw, out pctRaw);
                var ser = new DataContractJsonSerializer(typeof(ContractDto));
                using (var ms = new MemoryStream(new UTF8Encoding(false).GetBytes(raw)))
                {
                    dto = (ContractDto)ser.ReadObject(ms);
                }
            }
            catch { return s; }
            if (dto == null) return s;

            // session_id: non-empty string
            var sid = dto.session_id;
            if (string.IsNullOrEmpty(sid)) return s;

            // last_pct: null or finite 0..100 (never clamped). A number-type
            // key is required; string/object/array where a number belongs, or
            // out-of-range/non-finite numbers => invalid sample.
            double? pct = null;
            if (pctPresent)
            {
                if (double.IsNaN(pctRaw) || double.IsInfinity(pctRaw) || pctRaw < 0.0 || pctRaw > 100.0) return s;
                pct = pctRaw;
            }
            else if (RawJsonScan.KeyPresentWithWrongType(raw, "last_pct"))
            {
                return s; // wrong JSON type: contract violation => invalid
            }

            // updated_at: must parse (round-trip kind; UTC comparisons)
            DateTime? when = null;
            if (!string.IsNullOrEmpty(dto.updated_at))
            {
                DateTime parsed;
                if (!DateTime.TryParse(dto.updated_at, CultureInfo.InvariantCulture,
                        DateTimeStyles.RoundtripKind, out parsed)) return s;
                when = DateTime.SpecifyKind(parsed, parsed.Kind == DateTimeKind.Unspecified ? DateTimeKind.Utc : parsed.Kind).ToUniversalTime();
            }

            return new StateSample { SessionId = sid, Pct = pct, UpdatedAtUtc = when, Valid = true };
        }

        /// <summary>Read one state file with Windows-safe sharing so a concurrent
        /// Guardian atomic rename is never blocked or disturbed by the overlay.</summary>
        public static StateSample ReadStateFile(string path)
        {
            try
            {
                var fi = new FileInfo(path);
                if (!fi.Exists || fi.Length == 0) return Invalid(path);
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete))
                {
                    return ParseState(fs, path);
                }
            }
            catch { return Invalid(path); }
        }

        private static StateSample Invalid(string path)
        {
            return new StateSample { SessionId = path, Pct = null, UpdatedAtUtc = null, Valid = false };
        }

        /// <summary>Enumerate *.json state files in a directory (never *.tmp,
        /// never *.lock) and parse each tolerantly.</summary>
        public static List<StateSample> ScanStateDirectory(string dir)
        {
            var samples = new List<StateSample>();
            try
            {
                if (!Directory.Exists(dir)) return samples;
                foreach (var f in Directory.GetFiles(dir, "*.json"))
                {
                    if (f.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
                    samples.Add(ReadStateFile(f));
                }
            }
            catch { /* partial directory scan tolerated; sweep recovers */ }
            return samples;
        }

        // ---------------------------------------------------------- staleness --

        public static bool IsStale(StateSample s, DateTime nowUtc, TimeSpan staleAfter)
        {
            if (s == null || !s.Valid || s.UpdatedAtUtc == null) return true;
            return (nowUtc - s.UpdatedAtUtc.Value) > staleAfter;
        }

        public static bool IsImplausibleFuture(StateSample s, DateTime nowUtc)
        {
            if (s == null || !s.Valid || s.UpdatedAtUtc == null) return false;
            return (s.UpdatedAtUtc.Value - nowUtc) > FutureTolerance;
        }

        // ---------------------------------------------------------- selection --

        /// <summary>
        /// Winner selection — RISK BAND FIRST, RECENCY SECOND (P9.2b).
        /// Among sessions that already pass validation (valid id/pct/timestamp,
        /// non-stale, plausible timestamp): the higher risk band wins; within
        /// the same band, the newer updated_at wins. This prevents a fresh
        /// low-percentage session from hiding a still-live high-risk session.
        /// Never file mtime; never event order.
        /// </summary>
        public static StateSample SelectSession(IEnumerable<StateSample> samples, DateTime nowUtc, TimeSpan staleAfter)
        {
            StateSample best = null;
            int bestBand = -1;
            DateTime bestTime = DateTime.MinValue;
            foreach (var s in samples)
            {
                if (s == null || !s.Valid) continue;
                if (IsStale(s, nowUtc, staleAfter)) continue;
                if (IsImplausibleFuture(s, nowUtc)) continue; // clock skew cannot win
                if (s.UpdatedAtUtc == null) continue;
                // Null/awaiting samples carry no risk signal: they never
                // outrank a numeric sample and behave band-negatively so a
                // fresh PostCompact reset cannot hide a live high-risk session.
                int band = RiskBand(s.Pct);
                if (best == null || band > bestBand ||
                    (band == bestBand && s.UpdatedAtUtc.Value > bestTime))
                {
                    bestBand = band;
                    bestTime = s.UpdatedAtUtc.Value;
                    best = s;
                }
            }
            return best;
        }

        /// <summary>Risk band from last_pct: 3 = &gt;=90, 2 = &gt;=80, 1 = &gt;=70,
        /// 0 = below 70. Null (awaiting) samples band at -1: they can only win
        /// when no numeric session is live.</summary>
        public static int RiskBand(double? pct)
        {
            if (pct == null) return -1;
            if (pct.Value >= 90) return 3;
            if (pct.Value >= 80) return 2;
            if (pct.Value >= 70) return 1;
            return 0;
        }

        /// <summary>Count of non-stale, plausibly-timestamped samples (for the
        /// multi-session dot indicator).</summary>
        public static int CountActive(IEnumerable<StateSample> samples, DateTime nowUtc, TimeSpan staleAfter)
        {
            int n = 0;
            foreach (var s in samples)
            {
                if (s == null || !s.Valid) continue;
                if (IsStale(s, nowUtc, staleAfter)) continue;
                if (IsImplausibleFuture(s, nowUtc)) continue;
                n++;
            }
            return n;
        }

        // -------------------------------------------------------------- bands --

        /// <summary>Threshold bands: &lt;70 green, 70-79.99 yellow, 80-89.99
        /// orange, >=90 red; null pct => awaiting band.</summary>
        public static ContextBand MapBand(double? pct)
        {
            if (pct == null) return ContextBand.AwaitStale;
            if (pct.Value >= 90.0) return ContextBand.Red;
            if (pct.Value >= 80.0) return ContextBand.Orange;
            if (pct.Value >= 70.0) return ContextBand.Yellow;
            return ContextBand.Green;
        }

        /// <summary>Full display model from a directory scan.</summary>
        public static DisplayState BuildDisplay(string stateDir, DateTime nowUtc, TimeSpan staleAfter)
        {
            var samples = ScanStateDirectory(stateDir);
            var winner = SelectSession(samples, nowUtc, staleAfter);
            var d = new DisplayState();
            if (winner == null)
            {
                d.HasSession = false;
                d.Pct = null;
                d.Band = ContextBand.AwaitStale;
                d.MultiSession = false;
                d.SessionId = null;
                return d;
            }
            d.HasSession = true;
            d.Pct = winner.Pct;
            d.Band = MapBand(winner.Pct);
            d.SessionId = winner.SessionId;
            d.MultiSession = CountActive(samples, nowUtc, staleAfter) >= 2;
            return d;
        }

        // ------------------------------------------------------ interpolation --

        /// <summary>
        /// One interpolation step toward the target. Moves at most maxStep
        /// percentage points per call (frames at 20 FPS => smooth without
        /// overshoot). Returns the target when within one step.
        /// </summary>
        public static double NextDisplayed(double current, double target, double maxStep)
        {
            if (maxStep <= 0) return target;
            var diff = target - current;
            if (Math.Abs(diff) <= maxStep) return target;
            return current + Math.Sign(diff) * maxStep;
        }

        /// <summary>Height fraction (0..1) of the liquid fill for a percentage.
        /// 20% => low fill; 90% => nearly full.</summary>
        public static double HeightFraction(double pct)
        {
            var p = Math.Max(0.0, Math.Min(100.0, pct));
            return p / 100.0;
        }
    }

    // Minimal strict-shape scanner for the flat Guardian state object.
    internal static class RawJsonScan
    {
        /// <summary>True when "key" exists with a JSON number value.</summary>
        public static bool TryExtractLastPct(string raw, out double value)
        {
            value = 0.0;
            if (string.IsNullOrEmpty(raw)) return false;
            int idx = raw.IndexOf("\"last_pct\"", StringComparison.Ordinal);
            if (idx < 0) return false;
            int i = idx + "\"last_pct\"".Length;
            i = SkipWs(raw, i);
            if (i >= raw.Length || raw[i] != ':') return false;
            i++;
            i = SkipWs(raw, i);
            if (i >= raw.Length) return false;
            char c = raw[i];
            if (c == 'n') return false;          // null => "not a number" (awaiting)
            if (c == '"' || c == '{' || c == '[' || c == 't' || c == 'f') return false; // wrong type
            int start = i;
            while (i < raw.Length && (char.IsDigit(raw[i]) || raw[i] == '.' || raw[i] == 'e' || raw[i] == 'E' || raw[i] == '-' || raw[i] == '+')) i++;
            var tok = raw.Substring(start, i - start);
            double v;
            if (!double.TryParse(tok, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return false;
            value = v;
            return true;
        }

        /// <summary>True when "key" exists but with a non-number, non-null JSON
        /// value (string/object/array/bool) — a contract violation.</summary>
        public static bool KeyPresentWithWrongType(string raw, string key)
        {
            if (string.IsNullOrEmpty(raw)) return false;
            int idx = raw.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (idx < 0) return false;
            int i = idx + key.Length + 2;
            i = SkipWs(raw, i);
            if (i >= raw.Length || raw[i] != ':') return false;
            i++;
            i = SkipWs(raw, i);
            if (i >= raw.Length) return false;
            char c = raw[i];
            return c == '"' || c == '{' || c == '[' || c == 't' || c == 'f';
        }

        private static int SkipWs(string s, int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
            return i;
        }
    }

    // DataContract DTO: unknown members are skipped by DataContractJsonSerializer
    // (forward-compatible extension data per contract v1).
    [DataContract]
    internal sealed class ContractDto
    {
        [DataMember(Name = "session_id", EmitDefaultValue = false, IsRequired = false)]
        public string session_id;

        [DataMember(Name = "updated_at", EmitDefaultValue = false, IsRequired = false)]
        public string updated_at;
    }
}
