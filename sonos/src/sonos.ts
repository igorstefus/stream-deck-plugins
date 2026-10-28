/**
 * Minimal Sonos control over the local UPnP/SOAP API: SSDP discovery, zone group topology,
 * transport (play/pause/next/previous), volume and grouping. No dependencies beyond Node.
 */
import dgram from "node:dgram";
import os from "node:os";

export interface Speaker {
  /** Sonos player id, e.g. RINCON_7828CAFE16CA01400. Stable across IP changes. */
  uuid: string;
  /** Room name shown in the Sonos app. */
  name: string;
  /** IP address (or host name) of the player. */
  host: string;
  /** UUID of the group coordinator; equals `uuid` when the speaker is standalone or leads its group. */
  coordinator: string;
  /** Zone group id. */
  groupId: string;
}

export type TransportState = "PLAYING" | "PAUSED_PLAYBACK" | "STOPPED" | "TRANSITIONING" | "NO_MEDIA_PRESENT" | string;

type Log = (message: string) => void;

const SOAP_PORT = 1400;
const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SEARCH_TARGET = "urn:schemas-upnp-org:device:ZonePlayer:1";

const SERVICES = {
  AVTransport: { path: "/MediaRenderer/AVTransport/Control", urn: "urn:schemas-upnp-org:service:AVTransport:1" },
  RenderingControl: { path: "/MediaRenderer/RenderingControl/Control", urn: "urn:schemas-upnp-org:service:RenderingControl:1" },
  GroupRenderingControl: { path: "/MediaRenderer/GroupRenderingControl/Control", urn: "urn:schemas-upnp-org:service:GroupRenderingControl:1" },
  ZoneGroupTopology: { path: "/ZoneGroupTopology/Control", urn: "urn:schemas-upnp-org:service:ZoneGroupTopology:1" },
} as const;

type Service = keyof typeof SERVICES;

export class SonosError extends Error {
  readonly upnpCode?: number;
  constructor(message: string, upnpCode?: number) {
    super(message);
    this.name = "SonosError";
    this.upnpCode = upnpCode;
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : undefined;
}

/** Sends one SOAP action to a player and returns the raw response body (already checked for UPnP faults). */
export async function soap(host: string, service: Service, action: string, args: Record<string, string | number> = {}, timeoutMs = 4000): Promise<string> {
  const { path, urn } = SERVICES[service];
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
    .join("");
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${urn}">${argXml}</u:${action}></s:Body></s:Envelope>`;
  const response = await fetch(`http://${host}:${SOAP_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"${urn}#${action}"` },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    const code = Number(tag(text, "errorCode") ?? "0");
    throw new SonosError(`${action} on ${host} failed: HTTP ${response.status}${code ? `, UPnP error ${code}` : ""}`, code || undefined);
  }
  return text;
}

/** Transition not available: nothing queued to play. */
export const UPNP_NO_CONTENT = 701;

/** Parses the ZoneGroupState XML (unescaped) into visible speakers. */
export function parseZoneGroupState(xml: string): Speaker[] {
  const speakers: Speaker[] = [];
  for (const group of xml.matchAll(/<ZoneGroup\s+([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const groupAttrs = attributes(group[1]);
    const coordinator = groupAttrs.Coordinator ?? "";
    const groupId = groupAttrs.ID ?? coordinator;
    // Satellites (surrounds, subs) are nested <Satellite> elements inside the member; strip them so they are never listed.
    const members = group[2].replace(/<Satellite\b[^>]*\/?>([\s\S]*?<\/Satellite>)?/g, "");
    for (const member of members.matchAll(/<ZoneGroupMember\s+([^>]*?)\/?>/g)) {
      const a = attributes(member[1]);
      if (!a.UUID || a.Invisible === "1") {
        continue; // Boost, bridges and bonded satellites
      }
      const host = /^https?:\/\/([^:/]+)/.exec(a.Location ?? "")?.[1];
      if (!host) {
        continue;
      }
      speakers.push({ uuid: a.UUID, name: unescapeXml(a.ZoneName ?? a.UUID), host, coordinator, groupId });
    }
  }
  return speakers.sort((x, y) => x.name.localeCompare(y.name));
}

function attributes(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of fragment.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Finds Sonos players on the local network via SSDP M-SEARCH on every IPv4 interface. Resolves with their IPs. */
export function discoverHosts(timeoutMs = 2500, log: Log = () => undefined): Promise<string[]> {
  const found = new Set<string>();
  const request = Buffer.from(
    ["M-SEARCH * HTTP/1.1", `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', "MX: 1", `ST: ${SEARCH_TARGET}`, "", ""].join("\r\n"),
  );
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  if (addresses.length === 0) {
    addresses.push("0.0.0.0");
  }
  const sockets = addresses.map((address) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (e) => log(`ssdp socket ${address}: ${e.message}`));
    socket.on("message", (msg, remote) => {
      if (msg.toString().includes("ZonePlayer")) {
        found.add(remote.address);
      }
    });
    socket.bind(0, address, () => {
      try {
        socket.setBroadcast(true);
        socket.send(request, SSDP_PORT, SSDP_ADDRESS);
        socket.send(request, SSDP_PORT, "255.255.255.255");
      } catch (e) {
        log(`ssdp send ${address}: ${String(e)}`);
      }
    });
    return socket;
  });
  return new Promise((resolve) => {
    setTimeout(() => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          // already closed
        }
      }
      resolve([...found]);
    }, timeoutMs);
  });
}

/**
 * The household: discovers players, keeps the zone topology current and polls transport/volume state
 * for the speakers something on the deck is interested in.
 */
export class SonosSystem {
  speakers: Speaker[] = [];
  /** Transport state per group coordinator uuid. */
  readonly transport = new Map<string, TransportState>();
  /** Volume (0-100) per speaker uuid. */
  readonly volume = new Map<string, number>();
  /** Mute per speaker uuid. */
  readonly mute = new Map<string, boolean>();
  /** Known player IPs, newest first; persisted by the caller so startup does not depend on SSDP. */
  hosts: string[] = [];
  /** Optional player IP entered by the user for networks where multicast discovery fails. */
  manualHost = "";
  lastError = "";

  private readonly log: Log;
  private readonly onHostsChanged: (hosts: string[]) => void;
  private readonly listeners = new Set<() => void>();
  private readonly interest = new Map<string, number>();
  private topologyTimer?: ReturnType<typeof setInterval>;
  private stateTimer?: ReturnType<typeof setInterval>;
  private discovering?: Promise<void>;
  private refreshing?: Promise<void>;

  constructor(log: Log = () => undefined, onHostsChanged: (hosts: string[]) => void = () => undefined) {
    this.log = log;
    this.onHostsChanged = onHostsChanged;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        this.log(`listener failed: ${String(e)}`);
      }
    }
  }

  start(topologyEveryMs = 20000, stateEveryMs = 3000): void {
    this.stop();
    this.topologyTimer = setInterval(() => void this.refreshTopology(), topologyEveryMs);
    this.stateTimer = setInterval(() => void this.refreshState(), stateEveryMs);
    void this.refreshTopology();
  }

  stop(): void {
    if (this.topologyTimer) clearInterval(this.topologyTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.topologyTimer = undefined;
    this.stateTimer = undefined;
  }

  /** Marks speakers as shown on the deck so their state gets polled. Returns a release function. */
  watch(uuids: string[]): () => void {
    for (const u of uuids) {
      this.interest.set(u, (this.interest.get(u) ?? 0) + 1);
    }
    void this.refreshState(uuids);
    return () => {
      for (const u of uuids) {
        const n = (this.interest.get(u) ?? 1) - 1;
        if (n <= 0) this.interest.delete(u);
        else this.interest.set(u, n);
      }
    };
  }

  speaker(uuid: string): Speaker | undefined {
    return this.speakers.find((s) => s.uuid === uuid);
  }

  coordinatorOf(uuid: string): Speaker | undefined {
    const s = this.speaker(uuid);
    return s ? (this.speaker(s.coordinator) ?? s) : undefined;
  }

  /** Speakers in the same zone group as `uuid`. */
  groupOf(uuid: string): Speaker[] {
    const s = this.speaker(uuid);
    return s ? this.speakers.filter((o) => o.groupId === s.groupId) : [];
  }

  /** Host that last answered the topology with a proper household view; asked first next time. */
  private goodHost = "";

  /**
   * Hosts to ask for the topology, best first: the user's manual IP, the last good host, the visible
   * speakers, and only then raw SSDP results (those include subs, surrounds and Boosts, which answer
   * late or wrongly).
   */
  private candidateHosts(): string[] {
    const list = [this.manualHost, this.goodHost, ...this.speakers.map((s) => s.host), ...this.hosts].filter(Boolean);
    return [...new Set(list)];
  }

  /** Runs SSDP once (deduplicated while in flight) and remembers what it found. */
  async discover(): Promise<void> {
    if (!this.discovering) {
      this.discovering = (async () => {
        const hosts = await discoverHosts(2500, this.log);
        this.log(`ssdp found ${hosts.length} player(s): ${hosts.join(", ") || "none"}`);
        if (hosts.length) {
          this.rememberHosts(hosts);
        }
      })().finally(() => (this.discovering = undefined));
    }
    return this.discovering;
  }

  private rememberHosts(hosts: string[]): void {
    const merged = [...new Set([...hosts, ...this.hosts])].slice(0, 16);
    if (merged.join() !== this.hosts.join()) {
      this.hosts = merged;
      this.onHostsChanged(merged);
    }
  }

  /** Reloads the zone groups from any reachable player, discovering players first when none are known. */
  async refreshTopology(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefreshTopology().finally(() => (this.refreshing = undefined));
    }
    return this.refreshing;
  }

  private async doRefreshTopology(): Promise<void> {
    if (this.candidateHosts().length === 0) {
      await this.discover();
    }
    let lastErr = "";
    for (const host of this.candidateHosts()) {
      try {
        const xml = await soap(host, "ZoneGroupTopology", "GetZoneGroupState");
        const state = unescapeXml(tag(xml, "ZoneGroupState") ?? "");
        const speakers = parseZoneGroupState(state);
        if (speakers.length === 0) {
          throw new SonosError(`empty topology from ${host}`);
        }
        if (speakers.some((s) => !s.coordinator)) {
          // A Boost / Bridge answers with every room as an ":orphan" group without a coordinator: ask a real speaker instead.
          throw new SonosError(`${host} is a bridge (orphan topology)`);
        }
        const changed = JSON.stringify(speakers) !== JSON.stringify(this.speakers) || this.lastError !== "";
        this.speakers = speakers;
        this.lastError = "";
        this.goodHost = host;
        this.rememberHosts(speakers.map((s) => s.host));
        if (changed) {
          this.log(`topology via ${host}: ${speakers.map((s) => `${s.name}${s.coordinator === s.uuid ? "*" : ""}`).join(", ")}`);
          this.emit();
        }
        return;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        this.log(`topology via ${host}: ${lastErr}`);
      }
    }
    // Every known host failed (IPs changed?): try discovery so the next refresh has fresh hosts.
    this.lastError = lastErr || "no Sonos players found";
    this.emit();
    await this.discover();
  }

  /** Polls transport state (per group) and volume for the watched speakers. */
  async refreshState(only?: string[]): Promise<void> {
    const uuids = only ?? [...this.interest.keys()];
    if (uuids.length === 0 || this.speakers.length === 0) {
      return;
    }
    let changed = false;
    const coordinators = new Map<string, Speaker>();
    const players: Speaker[] = [];
    for (const u of uuids) {
      const s = this.speaker(u);
      if (!s) continue;
      players.push(s);
      const c = this.coordinatorOf(u);
      if (c) coordinators.set(c.uuid, c);
    }
    await Promise.all([
      ...[...coordinators.values()].map(async (c) => {
        try {
          const xml = await soap(c.host, "AVTransport", "GetTransportInfo", { InstanceID: 0 });
          const state = tag(xml, "CurrentTransportState") ?? "STOPPED";
          if (this.transport.get(c.uuid) !== state) {
            this.transport.set(c.uuid, state);
            changed = true;
          }
        } catch (e) {
          this.log(`transport ${c.name}: ${String(e)}`);
        }
      }),
      ...players.map(async (p) => {
        try {
          const [vXml, mXml] = await Promise.all([
            soap(p.host, "RenderingControl", "GetVolume", { InstanceID: 0, Channel: "Master" }),
            soap(p.host, "RenderingControl", "GetMute", { InstanceID: 0, Channel: "Master" }),
          ]);
          const v = Number(tag(vXml, "CurrentVolume") ?? "0");
          const m = tag(mXml, "CurrentMute") === "1";
          if (this.volume.get(p.uuid) !== v || this.mute.get(p.uuid) !== m) {
            this.volume.set(p.uuid, v);
            this.mute.set(p.uuid, m);
            changed = true;
          }
        } catch (e) {
          this.log(`volume ${p.name}: ${String(e)}`);
        }
      }),
    ]);
    if (changed) {
      this.emit();
    }
  }

  /** True when the group that `uuid` belongs to is playing. */
  isPlaying(uuid: string): boolean {
    const c = this.coordinatorOf(uuid);
    return !!c && this.transport.get(c.uuid) === "PLAYING";
  }

  // ---- commands -------------------------------------------------------------------------------

  /** Sends Play/Pause/Next/Previous to the group coordinator of each speaker (deduplicated per group). */
  async transportCommand(uuids: string[], command: "Play" | "Pause" | "Next" | "Previous" | "Stop"): Promise<void> {
    const targets = new Map<string, Speaker>();
    for (const u of uuids) {
      const c = this.coordinatorOf(u);
      if (c) targets.set(c.uuid, c);
    }
    await Promise.all(
      [...targets.values()].map(async (c) => {
        try {
          const args: Record<string, string | number> = { InstanceID: 0 };
          if (command === "Play") args.Speed = 1;
          await soap(c.host, "AVTransport", command, args);
          if (command === "Play") this.transport.set(c.uuid, "PLAYING");
          if (command === "Pause" || command === "Stop") this.transport.set(c.uuid, "PAUSED_PLAYBACK");
        } catch (e) {
          // 701 = nothing to play (empty queue / radio stopped): not worth an alert.
          if (!(e instanceof SonosError && e.upnpCode === UPNP_NO_CONTENT)) throw e;
          this.log(`${command} ${c.name}: nothing to play`);
        }
      }),
    );
    this.emit();
  }

  /** Pauses every targeted group if any of them is playing, otherwise plays them all. */
  async togglePlayPause(uuids: string[]): Promise<void> {
    const anyPlaying = uuids.some((u) => this.isPlaying(u));
    await this.transportCommand(uuids, anyPlaying ? "Pause" : "Play");
  }

  async setRelativeVolume(uuids: string[], delta: number): Promise<void> {
    await Promise.all(
      uuids.map(async (u) => {
        const s = this.speaker(u);
        if (!s) return;
        const xml = await soap(s.host, "RenderingControl", "SetRelativeVolume", { InstanceID: 0, Channel: "Master", Adjustment: delta });
        this.volume.set(u, Number(tag(xml, "NewVolume") ?? this.volume.get(u) ?? 0));
      }),
    );
    this.emit();
  }

  /**
   * One volume step for a key with several rooms: the `equalized` rooms all land on the same level
   * (the quietest of them plus `delta`), while the `own` rooms keep their own level and just move by
   * `delta`. A single room behaves like a plain relative step.
   */
  async adjustVolume(equalized: string[], own: string[], delta: number): Promise<void> {
    const known = equalized.filter((u) => this.speaker(u));
    if (known.some((u) => this.volume.get(u) === undefined)) {
      await this.refreshState(known);
    }
    const levels = known.map((u) => this.volume.get(u)).filter((v): v is number => typeof v === "number");
    const jobs: Promise<void>[] = [];
    if (levels.length > 0) {
      jobs.push(this.setVolume(known, Math.min(...levels) + delta));
    }
    const followers = own.filter((u) => this.speaker(u) && !known.includes(u));
    if (followers.length > 0) {
      jobs.push(this.setRelativeVolume(followers, delta));
    }
    await Promise.all(jobs);
  }

  async setVolume(uuids: string[], value: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(value)));
    await Promise.all(
      uuids.map(async (u) => {
        const s = this.speaker(u);
        if (!s) return;
        await soap(s.host, "RenderingControl", "SetVolume", { InstanceID: 0, Channel: "Master", DesiredVolume: v });
        this.volume.set(u, v);
      }),
    );
    this.emit();
  }

  /** Mutes all targeted speakers if any is unmuted, otherwise unmutes them. */
  async toggleMute(uuids: string[]): Promise<void> {
    const mute = uuids.some((u) => !this.mute.get(u));
    await Promise.all(
      uuids.map(async (u) => {
        const s = this.speaker(u);
        if (!s) return;
        await soap(s.host, "RenderingControl", "SetMute", { InstanceID: 0, Channel: "Master", DesiredMute: mute ? 1 : 0 });
        this.mute.set(u, mute);
      }),
    );
    this.emit();
  }

  /** True when all given speakers are already in one zone group. */
  isGrouped(uuids: string[]): boolean {
    const groups = new Set(uuids.map((u) => this.speaker(u)?.groupId ?? u));
    return uuids.length > 1 && groups.size === 1;
  }

  /**
   * Joins the speakers into one group led by `coordinator` (defaults to one that is already a
   * coordinator and playing, else the first). Members already in that group are left alone.
   */
  async group(uuids: string[], coordinator?: string): Promise<void> {
    const members = uuids.map((u) => this.speaker(u)).filter((s): s is Speaker => !!s);
    if (members.length < 2) {
      return;
    }
    let lead = coordinator ? this.speaker(coordinator) : undefined;
    if (!lead || !members.some((m) => m.uuid === lead?.uuid)) {
      lead =
        members.find((m) => m.coordinator === m.uuid && this.transport.get(m.uuid) === "PLAYING") ??
        members.find((m) => m.coordinator === m.uuid) ??
        members[0];
    }
    const leadUuid = lead.uuid;
    // If the lead is itself a member of another group, make it standalone first so it can lead.
    if (lead.coordinator !== lead.uuid) {
      await soap(lead.host, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", { InstanceID: 0 });
    }
    await Promise.all(
      members
        .filter((m) => m.uuid !== leadUuid && m.coordinator !== leadUuid)
        .map((m) => soap(m.host, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: `x-rincon:${leadUuid}`, CurrentURIMetaData: "" })),
    );
    await this.settleTopology();
  }

  /** Makes each given speaker standalone (leaves its group). A group's coordinator leaving hands the group to another member. */
  async ungroup(uuids: string[]): Promise<void> {
    const members = uuids.map((u) => this.speaker(u)).filter((s): s is Speaker => !!s);
    // Non-coordinators first, then coordinators whose group still has other members.
    const ordered = [...members.filter((m) => m.coordinator !== m.uuid), ...members.filter((m) => m.coordinator === m.uuid)];
    for (const m of ordered) {
      const groupSize = this.groupOf(m.uuid).length;
      if (m.coordinator === m.uuid && groupSize <= 1) {
        continue; // already standalone
      }
      await soap(m.host, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", { InstanceID: 0 });
      // Keep the local model roughly in sync so later iterations see the new group sizes.
      m.coordinator = m.uuid;
      m.groupId = `${m.uuid}:standalone`;
    }
    await this.settleTopology();
  }

  /** Toggles: ungroups when the speakers are already together, otherwise groups them. */
  async toggleGroup(uuids: string[], coordinator?: string): Promise<void> {
    if (this.isGrouped(uuids)) {
      await this.ungroup(uuids);
    } else {
      await this.group(uuids, coordinator);
    }
  }

  private async settleTopology(): Promise<void> {
    // Sonos reports the new topology a moment after the join/leave completes.
    await new Promise((r) => setTimeout(r, 1200));
    await this.refreshTopology();
    await this.refreshState();
  }
}
