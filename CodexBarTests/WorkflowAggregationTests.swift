import Foundation
import Testing

struct WorkflowAggregationTests {
    @Test func missingHookCountsRemainUnavailableThroughLocalStorage() throws {
        let aggregate = try TestFixtures.decode(WorkflowDailyAggregate.self, #"{"date":"2026-09-15","stopCount":0}"#)
        #expect(aggregate.eventCount == nil)
        #expect(aggregate.interruptCount == nil)
        #expect(aggregate.stopCount == 0)
        let local = try JSONDecoder().decode(WorkflowDailyAggregate.self, from: aggregate.jsonLineData())
        #expect(local == aggregate)
    }

    @Test func eventPairsAndIdentifiersAreCountedWithoutDoubleCounting() {
        var accumulator = makeAccumulator()
        for name in [CodexHookEvent.sessionStart, .userPromptSubmit, .preToolUse, .postToolUse, .preCompact, .postCompact, .subagentStart, .subagentStop] {
            accumulator.record(TestFixtures.event(name))
        }
        accumulator.record(TestFixtures.event(.stop, session: "terminal-only", turn: "terminal-only"))
        accumulator.record(TestFixtures.event(.interrupt, session: "interrupt-only", turn: "interrupt-only"))
        let retained = accumulator.finalized(identifierStorage: .retained)
        let compacted = accumulator.finalized(identifierStorage: .compacted)
        #expect(retained.eventCount == 10)
        #expect(retained.sessionIds == ["interrupt-only", "session-a", "terminal-only"])
        #expect(retained.turnIds == ["turn-a"])
        #expect(retained.metrics.toolCallCount == 1)
        #expect(retained.metrics.contextCompactionCount == 1)
        #expect(retained.metrics.subagentCount == 1)
        #expect(retained.metrics.interruptCount == 1)
        #expect(retained.metrics == compacted.metrics)
        #expect(compacted.sessionIds == nil)
        #expect(compacted.turnIds == nil)
        #expect(!compacted.supportsIncrementalAggregation)
    }

    @Test func incrementalAggregationMatchesFullReplay() {
        let firstEvents = [TestFixtures.event(.sessionStart), TestFixtures.event()]
        let laterEvents = [TestFixtures.event(.preToolUse), TestFixtures.event(turn: "turn-b")]
        var full = makeAccumulator()
        (firstEvents + laterEvents).forEach { full.record($0) }
        var initial = makeAccumulator()
        firstEvents.forEach { initial.record($0) }
        var incremental = WorkflowDailyAccumulator(
            appending: initial.finalized(identifierStorage: .retained), sourceGeneration: "source", sourceIsFresh: true
        )
        laterEvents.forEach { incremental.record($0) }
        #expect(incremental.finalized(identifierStorage: .retained) == full.finalized(identifierStorage: .retained))
    }

    @Test func historicalAggregationIncludesAutoReviewEvents() {
        var accumulator = makeAccumulator()
        accumulator.record(TestFixtures.event(origin: .autoReview))
        #expect(accumulator.finalized(identifierStorage: .compacted).metrics.turnCount == 1)
    }

    @Test func sessionEndAloneDoesNotCreateAnActiveSession() {
        var accumulator = makeAccumulator()
        accumulator.record(TestFixtures.event(.sessionEnd, turn: nil))
        let aggregate = accumulator.finalized(identifierStorage: .compacted)
        #expect(aggregate.sessionEndCount == 1)
        #expect(aggregate.metrics.sessionCount == 0)
        #expect(aggregate.metrics.turnCount == 0)
    }

    @Test func unavailableInterruptCountPropagatesAcrossDeviceMetrics() {
        var known = TestFixtures.aggregate()
        known.interruptCount = 3
        var unknown = TestFixtures.aggregate()
        unknown.interruptCount = nil
        #expect(known.metrics.adding(unknown.metrics).interruptCount == nil)
        #expect(known.metrics.adding(known.metrics).interruptCount == 6)
    }

    @Test func modelRankingHasDeterministicTiesAndIgnoresZeroCounts() {
        var aggregate = TestFixtures.aggregate()
        aggregate.modelCounts = ["z-model": 3, "a-model": 3, "unused": 0]
        #expect(aggregate.metrics.mostUsedModel == "a-model")
        aggregate.modelCounts = ["unused": 0]
        #expect(aggregate.metrics.mostUsedModel == nil)
    }

    @Test func compactingLegacyIdentifiersPreservesUniqueCounts() throws {
        var aggregate = try TestFixtures.decode(WorkflowDailyAggregate.self, """
        {"date":"2026-09-15","sessionCount":0,"sessionIds":["a","a","b"],"turnIds":["x","x"],"stopCount":9}
        """)
        aggregate.normalizeIdentifierStorage(retainsIdentifiers: false)
        #expect(aggregate.sessionCount == 2)
        #expect(aggregate.turnCount == 1)
        #expect(aggregate.sessionIds == nil)
    }

    @Test func compactedStorageContainsCountsWithoutRawTaskIdentifiers() throws {
        var accumulator = makeAccumulator()
        accumulator.record(TestFixtures.event())
        let data = try accumulator.finalized(identifierStorage: .compacted).jsonLineData()
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["sessionIds"] == nil || object["sessionIds"] is NSNull)
        #expect(object["turnIds"] == nil || object["turnIds"] is NSNull)
        #expect(object["sessionCount"] as? Int == 1)
        let text = try #require(String(data: data, encoding: .utf8))
        #expect(!text.contains("session-a"))
    }

    private func makeAccumulator() -> WorkflowDailyAccumulator {
        WorkflowDailyAccumulator(rebuilding: "2026-09-15", sourceGeneration: "source", sourceIsFresh: true, hookCountAvailability: .all)
    }
}
