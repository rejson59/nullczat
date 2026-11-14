"use client";

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

let client: SupabaseClient | null = null;

export function live(): SupabaseClient {
  if (!client) {
    client = createClient(URL_, KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 25 } },
    });
  }
  return client;
}

export type RoomRef = { room: string; exp: string | null };

function pick(data: unknown): RoomRef | null {
  if (!data) return null;
  const d = data as { room?: unknown; exp?: unknown };
  if (typeof d.room !== "string") return null;
  return { room: d.room, exp: typeof d.exp === "string" ? d.exp : null };
}

export function openChannel(roomId: string, seat: string): RealtimeChannel {
  const name = "nz:" + roomId.replace(/-/g, "").slice(0, 24);
  return live().channel(name, {
    config: {
      broadcast: { self: false, ack: true },
      presence: { key: seat.slice(0, 16) },
    },
  });
}

export async function createRoom(invite: string, destroy: string, seat: string): Promise<RoomRef | null> {
  const { data, error } = await live().rpc("nz_create", {
    p_invite: invite,
    p_destroy: destroy,
    p_seat: seat,
  });
  if (error) return null;
  return pick(data);
}

export async function claimRoom(invite: string, seat: string): Promise<RoomRef | null> {
  const { data, error } = await live().rpc("nz_claim", { p_invite: invite, p_seat: seat });
  if (error) return null;
  return pick(data);
}

export async function destroyRoom(destroy: string): Promise<void> {
  try {
    await live().rpc("nz_destroy", { p_destroy: destroy });
  } catch {
    /* best effort */
  }
}
