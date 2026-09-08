// Overlay logic test harness — compiled WITHOUT WPF references by
// scripts/run-tests.ps1. Asserts the State Contract v1 semantics.
// Exit 0 = all pass; exit 1 = failures. No test framework, offline.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using GuardianOverlay;

static class TestMain
{
    static int _failures;

    static void Ok(string name, bool cond, string detail = null)
    {
        if (cond) { Console.WriteLine("PASS  " + name); }
        else { _failures++; Console.WriteLine("FAIL  " + name + "   [" + (detail ?? "") + "]"); }
    }

    static StateSample P(string json) { return GuardianLogic.ParseState(new MemoryStream(Encoding.UTF8.GetBytes(json)), "fb"); }

    static void Main()
    {
        var now = new DateTime(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc);
        var fresh = new DateTime(2026, 9, 7, 11, 59, 0, DateTimeKind.Utc);        // 1 min old
        var old = new DateTime(2026, 9, 7, 11, 40, 0, DateTimeKind.Utc);          // 20 min old
        var staleAfter = TimeSpan.FromMinutes(15);

        // ---- required field parsing -------------------------------------------------
        var ok = P("{\"session_id\":\"sess-1\",\"last_pct\":42,\"updated_at\":\"2026-09-07T11:59:00.000Z\",\"extra_unknown\":{\"a\":[1,2]}}");
        Ok("parse: full sample", ok.Valid && ok.SessionId == "sess-1" && ok.Pct == 42.0 && ok.UpdatedAtUtc == fresh, Json(ok));

        var nullPct = P("{\"session_id\":\"sess-2\",\"last_pct\":null,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}");
        Ok("parse: null pct -> awaiting sample", nullPct.Valid && nullPct.Pct == null, Json(nullPct));

        Ok("parse: unknown fields ignored",
            P("{\"session_id\":\"u\",\"last_pct\":5,\"updated_at\":\"2026-09-07T11:59:00.000Z\",\"fired70\":true,\"last_usage_id\":\"zz\",\"future_field\":{\"x\":1}}").Valid);

        // ---- validation rules -------------------------------------------------------
        Ok("invalid: pct < 0 rejected", !P("{\"session_id\":\"v\",\"last_pct\":-0.5,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}").Valid);
        Ok("invalid: pct > 100 rejected", !P("{\"session_id\":\"v\",\"last_pct\":100.5,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}").Valid);
        Ok("boundary: pct 0 valid", P("{\"session_id\":\"v\",\"last_pct\":0,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}").Valid);
        Ok("boundary: pct 100 valid", P("{\"session_id\":\"v\",\"last_pct\":100,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}").Valid);
        Ok("boundary: pct 69.99/70/79.99/80/89.99/90 bands",
            GuardianLogic.MapBand(69.99) == ContextBand.Green && GuardianLogic.MapBand(70) == ContextBand.Yellow &&
            GuardianLogic.MapBand(79.99) == ContextBand.Yellow && GuardianLogic.MapBand(80) == ContextBand.Orange &&
            GuardianLogic.MapBand(89.99) == ContextBand.Orange && GuardianLogic.MapBand(90) == ContextBand.Red);
        Ok("invalid: pct as string rejected", !P("{\"session_id\":\"v\",\"last_pct\":\"42\",\"updated_at\":\"2026-09-07T11:59:00.000Z\"}").Valid);
        Ok("invalid: pct as object rejected", !P("{\"session_id\":\"v\",\"last_pct\":{},\"updated_at\":\"2026-09-07T11:59:00.000Z\"}").Valid);
        Ok("invalid: empty session_id rejected", !P("{\"session_id\":\"\",\"last_pct\":1,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}").Valid);
        Ok("invalid: missing session_id rejected", !P("{\"last_pct\":1,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}").Valid);
        Ok("invalid: bad timestamp rejected", !P("{\"session_id\":\"v\",\"last_pct\":1,\"updated_at\":\"not-a-date\"}").Valid);
        Ok("invalid: missing timestamp -> stale", GuardianLogic.IsStale(P("{\"session_id\":\"v\",\"last_pct\":1}"), now, staleAfter));
        Ok("invalid: corrupt JSON rejected", !P("{broken").Valid);
        Ok("invalid: empty object rejected", !P("{}").Valid);

        // ---- future timestamp cannot win -------------------------------------------
        var future = P("{\"session_id\":\"future\",\"last_pct\":10,\"updated_at\":\"2026-09-07T13:00:00.000Z\"}"); // +60 min
        Ok("future timestamp detected", GuardianLogic.IsImplausibleFuture(future, now));
        var withinTolerance = P("{\"session_id\":\"skew\",\"last_pct\":10,\"updated_at\":\"2026-09-07T12:03:00.000Z\"}"); // +3 min
        Ok("small clock skew tolerated", !GuardianLogic.IsImplausibleFuture(withinTolerance, now));

        var sFuture = new List<StateSample> { future, P("{\"session_id\":\"real\",\"last_pct\":20,\"updated_at\":\"2026-09-07T11:50:00.000Z\"}") };
        var winner = GuardianLogic.SelectSession(sFuture, now, staleAfter);
        Ok("future timestamp cannot win selection", winner != null && winner.SessionId == "real");

        // ---- staleness + selection --------------------------------------------------
        Ok("stale: 16 min old is stale", GuardianLogic.IsStale(P("{\"session_id\":\"s\",\"last_pct\":1,\"updated_at\":\"2026-09-07T11:44:00.000Z\"}"), now, staleAfter));
        Ok("fresh: 1 min old not stale", !GuardianLogic.IsStale(P("{\"session_id\":\"s\",\"last_pct\":1,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}"), now, staleAfter));

        var two = new List<StateSample>
        {
            P("{\"session_id\":\"older\",\"last_pct\":10,\"updated_at\":\"2026-09-07T11:50:00.000Z\"}"),
            P("{\"session_id\":\"newer\",\"last_pct\":80,\"updated_at\":\"2026-09-07T11:58:00.000Z\"}")
        };
        Ok("selection: newest updated_at wins", GuardianLogic.SelectSession(two, now, staleAfter).SessionId == "newer");
        Ok("multi-session count >= 2", GuardianLogic.CountActive(two, now, staleAfter) >= 2);

        var staleMix = new List<StateSample>
        {
            P("{\"session_id\":\"old-but-late\",\"last_pct\":30,\"updated_at\":\"2026-09-07T11:40:00.000Z\"}"),
            P("{\"session_id\":\"stale-fresh\",\"last_pct\":90,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}")
        };
        var w2 = GuardianLogic.SelectSession(staleMix, now, staleAfter);
        Ok("selection: stale loser not chosen (11:59 is fresh)", w2 != null && w2.SessionId == "stale-fresh");

        var allStale = new List<StateSample> { P("{\"session_id\":\"s\",\"last_pct\":1,\"updated_at\":\"2026-09-07T10:00:00.000Z\"}") };
        Ok("selection: all stale -> no winner", GuardianLogic.SelectSession(allStale, now, staleAfter) == null);

        // ---- risk-band-first selection (P9.2b): band first, recency second ----
        // Note: the old "newest wins" case above still holds (both band 0 vs 1?
        // older=10% band0, newer=80% band2 -> band-first also picks newer=80).
        Ok("band: RiskBand boundaries", GuardianLogic.RiskBand(69.99) == 0 && GuardianLogic.RiskBand(70) == 1 &&
            GuardianLogic.RiskBand(79.99) == 1 && GuardianLogic.RiskBand(80) == 2 &&
            GuardianLogic.RiskBand(89.99) == 2 && GuardianLogic.RiskBand(90) == 3 &&
            GuardianLogic.RiskBand(null) == -1);
        // A. 92% (2 min old, live) vs 18% (fresh) -> 92 wins (band 3 > 0)
        var bandA = new List<StateSample>
        {
            P("{\"session_id\":\"A-high\",\"last_pct\":92,\"updated_at\":\"2026-09-07T11:58:00.000Z\"}"),
            P("{\"session_id\":\"B-low\",\"last_pct\":18,\"updated_at\":\"2026-09-07T11:59:59.000Z\"}")
        };
        Ok("band A: 92% live beats fresh 18%", GuardianLogic.SelectSession(bandA, now, staleAfter).SessionId == "A-high");
        // B. stale 95% (4 days) vs fresh 30% -> 30 wins (stale excluded)
        var bandB = new List<StateSample>
        {
            P("{\"session_id\":\"A-stale\",\"last_pct\":95,\"updated_at\":\"2026-09-03T12:00:00.000Z\"}"),
            P("{\"session_id\":\"B-fresh\",\"last_pct\":30,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}")
        };
        Ok("band B: stale 95% ignored, fresh 30% wins", GuardianLogic.SelectSession(bandB, now, staleAfter).SessionId == "B-fresh");
        // C. 89% older-but-live (band 2) vs 71% newest (band 1) -> 89 wins
        var bandC = new List<StateSample>
        {
            P("{\"session_id\":\"A-89\",\"last_pct\":89,\"updated_at\":\"2026-09-07T11:50:00.000Z\"}"),
            P("{\"session_id\":\"B-71\",\"last_pct\":71,\"updated_at\":\"2026-09-07T11:59:59.000Z\"}")
        };
        Ok("band C: 89% (band2) beats fresher 71% (band1)", GuardianLogic.SelectSession(bandC, now, staleAfter).SessionId == "A-89");
        // D. 99% older (band 3) vs 91% newest (band 3) -> same band, recency: 91 wins
        var bandD = new List<StateSample>
        {
            P("{\"session_id\":\"A-99\",\"last_pct\":99,\"updated_at\":\"2026-09-07T11:48:00.000Z\"}"),
            P("{\"session_id\":\"B-91\",\"last_pct\":91,\"updated_at\":\"2026-09-07T11:59:59.000Z\"}")
        };
        Ok("band D: same band 3 -> newer 91% wins (not raw max 99%)", GuardianLogic.SelectSession(bandD, now, staleAfter).SessionId == "B-91");
        // E. 79% newer (band 1) vs 81% older-but-live (band 2) -> 81 wins
        var bandE = new List<StateSample>
        {
            P("{\"session_id\":\"A-79\",\"last_pct\":79,\"updated_at\":\"2026-09-07T11:59:59.000Z\"}"),
            P("{\"session_id\":\"B-81\",\"last_pct\":81,\"updated_at\":\"2026-09-07T11:52:00.000Z\"}")
        };
        Ok("band E: 81% (band2) beats fresher 79% (band1)", GuardianLogic.SelectSession(bandE, now, staleAfter).SessionId == "B-81");
        // F. fresh null/awaiting (PostCompact) vs older-but-live 85% -> 85 wins
        var bandF = new List<StateSample>
        {
            P("{\"session_id\":\"A-await\",\"last_pct\":null,\"updated_at\":\"2026-09-07T11:59:59.000Z\"}"),
            P("{\"session_id\":\"B-85\",\"last_pct\":85,\"updated_at\":\"2026-09-07T11:50:00.000Z\"}")
        };
        Ok("band F: fresh awaiting null does not hide live 85%", GuardianLogic.SelectSession(bandF, now, staleAfter).SessionId == "B-85");
        // G. five sessions, mixed bands/timestamps -> newest inside highest present band (91 band3)
        var bandG = new List<StateSample>
        {
            P("{\"session_id\":\"g20\",\"last_pct\":20,\"updated_at\":\"2026-09-07T11:48:00.000Z\"}"),
            P("{\"session_id\":\"g72\",\"last_pct\":72,\"updated_at\":\"2026-09-07T11:50:00.000Z\"}"),
            P("{\"session_id\":\"g88\",\"last_pct\":88,\"updated_at\":\"2026-09-07T11:58:00.000Z\"}"),
            P("{\"session_id\":\"g91\",\"last_pct\":91,\"updated_at\":\"2026-09-07T11:46:00.000Z\"}"),
            P("{\"session_id\":\"g94\",\"last_pct\":94,\"updated_at\":\"2026-09-07T11:44:00.000Z\"}")
        };
        Ok("band G: newest inside highest present band (91) wins over fresher 88 and higher 94",
            GuardianLogic.SelectSession(bandG, now, staleAfter).SessionId == "g91");
        // H. only low-band sessions -> newest valid wins (old intuitive behavior)
        var bandH = new List<StateSample>
        {
            P("{\"session_id\":\"h1\",\"last_pct\":10,\"updated_at\":\"2026-09-07T11:50:00.000Z\"}"),
            P("{\"session_id\":\"h2\",\"last_pct\":65,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}")
        };
        Ok("band H: only band-0 sessions -> newest wins", GuardianLogic.SelectSession(bandH, now, staleAfter).SessionId == "h2");
        // I. stale high-risk vs fresh low-risk -> fresh low wins (stale never shown)
        var bandI = new List<StateSample>
        {
            P("{\"session_id\":\"i-stale-95\",\"last_pct\":95,\"updated_at\":\"2026-09-07T11:40:00.000Z\"}"),
            P("{\"session_id\":\"i-fresh-30\",\"last_pct\":30,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}")
        };
        Ok("band I: stale 95% (>15min) loses to fresh 30%", GuardianLogic.SelectSession(bandI, now, staleAfter).SessionId == "i-fresh-30");
        // J. invalid/future/malformed excluded exactly as before
        var bandJ = new List<StateSample>
        {
            future,                                                        // future -> excluded
            P("{broken"),                                                  // malformed -> invalid
            P("{\"session_id\":\"j-neg\",\"last_pct\":-3,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}"), // invalid pct
            P("{\"session_id\":\"j-real\",\"last_pct\":45,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}")
        };
        Ok("band J: invalid/future/malformed still excluded", GuardianLogic.SelectSession(bandJ, now, staleAfter).SessionId == "j-real");
        // Same-band + exact same timestamp: deterministic first-seen wins (documented;
        // file enumeration order is the deterministic input, no new tie policy invented)
        var bandTie = new List<StateSample>
        {
            P("{\"session_id\":\"tie-first\",\"last_pct\":92,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}"),
            P("{\"session_id\":\"tie-second\",\"last_pct\":93,\"updated_at\":\"2026-09-07T11:59:00.000Z\"}")
        };
        Ok("band tie: same band + same timestamp -> an input-order-dependent winner is picked (implementation detail, not a public guarantee)",
            GuardianLogic.SelectSession(bandTie, now, staleAfter).SessionId == "tie-first");

        // ---- interpolation / height -------------------------------------------------
        Ok("lerp: converges", GuardianLogic.NextDisplayed(20, 22, 3) == 22 && GuardianLogic.NextDisplayed(20, 30, 3) == 23);
        Ok("lerp: upward", GuardianLogic.NextDisplayed(10, 10, 3) == 10);
        Ok("lerp: downward from 90 to 20 (post-compact fall)", GuardianLogic.NextDisplayed(90, 20, 3) == 87);
        Ok("height fraction", Math.Abs(GuardianLogic.HeightFraction(20) - 0.2) < 1e-9 && Math.Abs(GuardianLogic.HeightFraction(90) - 0.9) < 1e-9);

        // ---- file reading with safe sharing + real fixtures -------------------------
        var fixtureDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fixtures", "state");
        if (Directory.Exists(fixtureDir))
        {
            foreach (var f in Directory.GetFiles(fixtureDir, "*.json"))
            {
                var sample = GuardianLogic.ReadStateFile(f);
                var name = Path.GetFileName(f);
                if (name.StartsWith("valid-"))
                {
                    Ok("fixture: " + name + " parses valid", sample.Valid, "pct=" + sample.Pct);
                }
                else if (name.StartsWith("invalid-future-timestamp"))
                {
                    // Future timestamps parse but are marked implausible; they
                    // parse as samples yet can never win selection.
                    var nowUtc = new DateTime(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc);
                    Ok("fixture: " + name + " parses but cannot win",
                        sample.Valid && GuardianLogic.IsImplausibleFuture(sample, nowUtc) &&
                        GuardianLogic.SelectSession(new List<StateSample> { sample }, nowUtc, TimeSpan.FromMinutes(15)) == null,
                        Json(sample));
                }
                else if (name.StartsWith("invalid-"))
                    Ok("fixture: " + name + " parses invalid", !sample.Valid);
            }
        }
        else
        {
            Ok("fixtures directory found", false, fixtureDir);
        }

        if (_failures == 0) { Console.WriteLine("\nALL PASS"); Environment.Exit(0); }
        Console.WriteLine("\n" + _failures + " FAILURES");
        Environment.Exit(1);
    }

    static string Json(StateSample s)
    {
        return "sid=" + s.SessionId + " pct=" + s.Pct + " at=" + s.UpdatedAtUtc + " valid=" + s.Valid;
    }
}
