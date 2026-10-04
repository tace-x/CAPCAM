import { describe, expect, it } from "vitest";
import {
  isLocalConsumerDiagnosticMessage,
  isLocalConsumerDisposeMessage,
  isLocalConsumerDisposedMessage,
  isLocalConsumerInspectMessage,
  isLocalConsumerInspectedMessage,
  isLocalConsumerReceivedMessage,
  isLocalConsumerReadyMessage,
  isLocalConsumerStreamMessage,
  LOCAL_CONSUMER_PROTOCOL_VERSION,
} from "./local-consumer-protocol";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

function validTrack() {
  return {
    kind: "video",
    id: "virtual-track-1",
    label: "CapCam virtual video · local test bridge",
    readyState: "live",
    enabled: true,
    muted: false,
    settings: { width: 1280, height: 720, frameRate: 30, aspectRatio: 16 / 9 },
  };
}

describe("local consumer boundary protocol", () => {
  it("accepts only the versioned exact-shape ready envelope", () => {
    expect(isLocalConsumerReadyMessage({
      protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
      type: "capcam.local-consumer.ready",
    })).toBe(true);
    expect(isLocalConsumerReadyMessage({ type: "capcam.local-consumer.ready" })).toBe(false);
    expect(isLocalConsumerReadyMessage({ protocol: 2, type: "capcam.local-consumer.ready" })).toBe(false);
    expect(isLocalConsumerReadyMessage({ protocol: 1, type: "capcam.local-consumer.ready", privileged: true })).toBe(false);
  });

  it("requires a UUID, an actual caller-validated MediaStream, and exact stream keys", () => {
    const stream = { marker: "native-media-stream" };
    const valid = {
      protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
      type: "capcam.local-consumer.stream",
      requestId,
      stream,
    };
    const isTestStream = (value: unknown): value is typeof stream => value === stream;
    expect(isLocalConsumerStreamMessage(valid, isTestStream)).toBe(true);
    expect(isLocalConsumerStreamMessage({ ...valid, requestId: "short" }, isTestStream)).toBe(false);
    expect(isLocalConsumerStreamMessage({ ...valid, unexpected: true }, isTestStream)).toBe(false);
    expect(isLocalConsumerStreamMessage({ ...valid, stream: {} }, isTestStream)).toBe(false);
  });

  it("accepts a bounded result with sanitized track settings", () => {
    expect(isLocalConsumerReceivedMessage({
      protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
      type: "capcam.local-consumer.received",
      requestId,
      result: {
        accepted: true,
        displayStarted: true,
        isMediaStream: true,
        streamId: "stream-1",
        trackCount: 1,
        tracks: [validTrack()],
        receiverOrigin: "http://localhost:5173",
      },
    })).toBe(true);
  });

  it("accepts bounded presented-frame evidence and rejects impossible frame claims", () => {
    const frameEvidence = {
      frameCallbackSupported: true,
      frameCount: 24,
      firstMediaTime: 0.033,
      lastMediaTime: 0.8,
      videoWidth: 1280,
      videoHeight: 720,
      videoReadyState: 4,
      paused: false,
      trackReadyState: "live",
      sampledDurationMs: 1_200,
    };
    const envelope = {
      protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
      type: "capcam.local-consumer.received",
      requestId,
      result: {
        accepted: true,
        displayStarted: true,
        isMediaStream: true,
        streamId: "stream-1",
        trackCount: 1,
        tracks: [validTrack()],
        frameEvidence,
      },
    };
    expect(isLocalConsumerReceivedMessage(envelope)).toBe(true);
    expect(isLocalConsumerReceivedMessage({
      ...envelope,
      result: { ...envelope.result, frameEvidence: { ...frameEvidence, frameCount: 10_001 } },
    })).toBe(false);
    expect(isLocalConsumerReceivedMessage({
      ...envelope,
      result: { ...envelope.result, frameEvidence: { ...frameEvidence, frameCount: 1, videoWidth: 0 } },
    })).toBe(false);
    expect(isLocalConsumerReceivedMessage({
      ...envelope,
      result: { ...envelope.result, frameEvidence: { ...frameEvidence, deviceId: "not-allowed" } },
    })).toBe(false);
  });

  it("validates exact inspect commands and bounded consumer track snapshots", () => {
    const inspect = { protocol: 1, type: "capcam.local-consumer.inspect", requestId };
    const inspected = {
      protocol: 1,
      type: "capcam.local-consumer.inspected",
      requestId,
      result: {
        streamPresent: true,
        streamId: "stream-1",
        streamActive: false,
        trackCount: 1,
        tracks: [{ ...validTrack(), readyState: "ended" }],
      },
    };
    expect(isLocalConsumerInspectMessage(inspect)).toBe(true);
    expect(isLocalConsumerInspectMessage({ ...inspect, extra: true })).toBe(false);
    expect(isLocalConsumerInspectedMessage(inspected)).toBe(true);
    expect(isLocalConsumerInspectedMessage({ ...inspected, result: { ...inspected.result, trackCount: 2 } })).toBe(false);
    expect(isLocalConsumerInspectedMessage({
      ...inspected,
      result: { ...inspected.result, tracks: [{ ...validTrack(), deviceId: "not-allowed" }] },
    })).toBe(false);
    expect(isLocalConsumerInspectedMessage({
      ...inspected,
      result: { streamPresent: false, streamId: "stream-1", streamActive: null, trackCount: 0, tracks: [] },
    })).toBe(false);
  });

  it("validates correlated track-ended and page-disconnect diagnostics", () => {
    const endedTrack = { ...validTrack(), readyState: "ended" };
    const trackEnded = {
      protocol: 1,
      type: "capcam.local-consumer.track-ended",
      requestId,
      streamId: "stream-1",
      track: endedTrack,
    };
    const disconnected = {
      protocol: 1,
      type: "capcam.local-consumer.disconnected",
      requestId,
      reason: "pagehide",
      result: {
        streamPresent: true,
        streamId: "stream-1",
        streamActive: false,
        trackCount: 1,
        tracks: [endedTrack],
      },
    };
    expect(isLocalConsumerDiagnosticMessage(trackEnded)).toBe(true);
    expect(isLocalConsumerDiagnosticMessage({ ...trackEnded, track: validTrack() })).toBe(false);
    expect(isLocalConsumerDiagnosticMessage({ ...trackEnded, extra: true })).toBe(false);
    expect(isLocalConsumerDiagnosticMessage(disconnected)).toBe(true);
    expect(isLocalConsumerDiagnosticMessage({ ...disconnected, reason: "unknown" })).toBe(false);
    expect(isLocalConsumerDiagnosticMessage({
      ...disconnected,
      result: { ...disconnected.result, streamPresent: false },
    })).toBe(false);
  });

  it("rejects malformed result fields, oversized payload lists, and extra outer keys", () => {
    const result = { accepted: false, displayStarted: false, isMediaStream: true, trackCount: 0, message: "No live video track." };
    const base = {
      protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
      type: "capcam.local-consumer.received",
      requestId,
      result,
    };
    expect(isLocalConsumerReceivedMessage({ ...base, extra: "no" })).toBe(false);
    expect(isLocalConsumerReceivedMessage({ ...base, requestId: "not-a-uuid" })).toBe(false);
    expect(isLocalConsumerReceivedMessage({ ...base, result: { ...result, trackCount: 17 } })).toBe(false);
    expect(isLocalConsumerReceivedMessage({ ...base, result: { ...result, secret: "unexpected" } })).toBe(false);
  });

  it("rejects inconsistent media status and device-identifying track settings", () => {
    const envelope = {
      protocol: LOCAL_CONSUMER_PROTOCOL_VERSION,
      type: "capcam.local-consumer.received",
      requestId,
      result: {
        accepted: true,
        displayStarted: true,
        isMediaStream: true,
        trackCount: 1,
        tracks: [validTrack()],
      },
    };
    expect(isLocalConsumerReceivedMessage({
      ...envelope,
      result: { ...envelope.result, tracks: [{ ...validTrack(), settings: { ...validTrack().settings, deviceId: "secret" } }] },
    })).toBe(false);
    expect(isLocalConsumerReceivedMessage({
      ...envelope,
      result: { ...envelope.result, displayStarted: true, accepted: false },
    })).toBe(false);
  });

  it("accepts only the versioned exact-shape consumer dispose command", () => {
    const dispose = { protocol: 1, type: "capcam.local-consumer.dispose", requestId };
    expect(isLocalConsumerDisposeMessage(dispose)).toBe(true);
    expect(isLocalConsumerDisposeMessage({ ...dispose, extra: true })).toBe(false);
    expect(isLocalConsumerDisposeMessage({ ...dispose, requestId: "bad" })).toBe(false);
    expect(isLocalConsumerDisposeMessage({ ...dispose, protocol: 2 })).toBe(false);
  });

  it("validates bounded cleanup acknowledgement and rejects incomplete cleanup claims", () => {
    const disposed = {
      protocol: 1,
      type: "capcam.local-consumer.disposed",
      requestId,
      result: {
        completed: true,
        integrationState: "OFF",
        peerConnectionsClosed: true,
        localTracksEnded: true,
        error: null,
      },
    };
    expect(isLocalConsumerDisposedMessage(disposed)).toBe(true);
    expect(isLocalConsumerDisposedMessage({ ...disposed, result: { ...disposed.result, localTracksEnded: false } })).toBe(false);
    expect(isLocalConsumerDisposedMessage({ ...disposed, result: { ...disposed.result, peerConnectionsClosed: "yes" } })).toBe(false);
    expect(isLocalConsumerDisposedMessage({ ...disposed, result: { ...disposed.result, integrationState: "UNKNOWN" } })).toBe(false);
    expect(isLocalConsumerDisposedMessage({ ...disposed, result: { ...disposed.result, error: "x".repeat(401) } })).toBe(false);
    expect(isLocalConsumerDisposedMessage({ ...disposed, result: { ...disposed.result, untrusted: true } })).toBe(false);
    expect(isLocalConsumerDisposedMessage({ ...disposed, untrusted: true })).toBe(false);
  });
});
