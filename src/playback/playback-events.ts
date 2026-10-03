import { createEvent, type EventEnvelope } from "../messaging/events";
import type { PlaybackRecord } from "./playback-types";

export const PLAYBACK_EVENT_TYPES = [
  "playback.loading",
  "playback.loaded",
  "playback.play",
  "playback.pause",
  "playback.seek",
  "playback.timeupdate",
  "playback.ended",
  "playback.loop",
  "playback.loopchange",
  "playback.ratechange",
  "playback.stop",
  "playback.error",
  "playback.disposed",
] as const;

export type PlaybackEventType = (typeof PLAYBACK_EVENT_TYPES)[number];

export interface PlaybackEventPayload {
  playbackId: string;
  mediaId: string;
  timestamp: number;
  record: PlaybackRecord;
}

export type PlaybackEventEnvelope = EventEnvelope<PlaybackEventType>;

export function createPlaybackEvent(type: PlaybackEventType, record: PlaybackRecord): PlaybackEventEnvelope {
  const payload: PlaybackEventPayload = {
    playbackId: record.playbackId,
    mediaId: record.mediaId,
    timestamp: Date.now(),
    record,
  };
  return createEvent(type, payload) as PlaybackEventEnvelope;
}
