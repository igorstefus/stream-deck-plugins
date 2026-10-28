import streamDeck, {
  action,
  SingletonAction,
  type Action,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { SonosSystem, type Speaker } from "./sonos.js";
import { GREEN, RED, keyImage, type Glyph, type KeyImageOptions } from "./images.js";

const logger = streamDeck.logger.createScope("Sonos");

type GlobalSettings = {
  /** Player IPs seen so far: startup uses them before SSDP. */
  hosts?: string[];
  /** Optional player IP typed by the user for networks where multicast discovery fails. */
  host?: string;
}

/** Which speakers a key acts on: everything, or the ones ticked in the property inspector. */
type TargetSettings = {
  all?: boolean;
  speakers?: string[];
}

const sonos = new SonosSystem(
  (m) => logger.info(m),
  (hosts) => void streamDeck.settings.setGlobalSettings<GlobalSettings>({ ...globalSettings, hosts }),
);
let globalSettings: GlobalSettings = {};

function applyGlobalSettings(g: GlobalSettings): void {
  globalSettings = g;
  sonos.hosts = Array.isArray(g.hosts) ? g.hosts.filter((h) => typeof h === "string") : [];
  const manual = (g.host ?? "").trim();
  if (manual !== sonos.manualHost) {
    sonos.manualHost = manual;
    void sonos.refreshTopology();
  }
}

/** Resolves the settings' target to speaker uuids that currently exist. */
function targets(s: TargetSettings): string[] {
  if (s.all) {
    return sonos.speakers.map((sp) => sp.uuid);
  }
  const chosen = Array.isArray(s.speakers) ? s.speakers : [];
  return chosen.filter((u) => typeof u === "string" && sonos.speaker(u));
}

/** Title for a key: "All", the single speaker's name, or "Kitchen +2". */
function targetTitle(s: TargetSettings, uuids: string[]): string {
  if (s.all) return "All";
  if (uuids.length === 0) return "Pick speakers";
  const first = sonos.speaker(uuids[0])?.name ?? "?";
  return uuids.length === 1 ? first : `${first} +${uuids.length - 1}`;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Shared plumbing for the three actions: remembers settings per key, watches the targeted speakers
 * for state polling, and re-renders on every household change.
 */
abstract class SonosAction<T extends TargetSettings> extends SingletonAction<T> {
  private readonly visible = new Map<string, { action: Action<T>; settings: T; release: () => void; lastImage?: string }>();

  constructor() {
    super();
    sonos.onChange(() => this.renderAll());
  }

  protected abstract image(settings: T, uuids: string[]): KeyImageOptions;

  override onWillAppear(ev: WillAppearEvent<T>): void {
    this.track(ev.action, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<T>): void {
    const entry = this.visible.get(ev.action.id);
    entry?.release();
    this.visible.delete(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): void {
    this.track(ev.action, ev.payload.settings);
  }

  private track(a: Action<T>, settings: T): void {
    const previous = this.visible.get(a.id);
    previous?.release();
    const uuids = targets(settings);
    const entry = { action: a, settings, release: sonos.watch(uuids), lastImage: previous?.lastImage };
    this.visible.set(a.id, entry);
    void this.render(entry);
  }

  protected settingsOf(a: Action<T>): T {
    return this.visible.get(a.id)?.settings ?? ({} as T);
  }

  protected renderAll(): void {
    for (const entry of this.visible.values()) {
      void this.render(entry);
    }
  }

  private async render(entry: { action: Action<T>; settings: T; lastImage?: string }): Promise<void> {
    try {
      const uuids = targets(entry.settings);
      const opts = this.image(entry.settings, uuids);
      if (sonos.speakers.length === 0) {
        opts.dim = true;
        opts.subtitle = sonos.lastError ? "no Sonos found" : "searching…";
      } else if (uuids.length === 0) {
        opts.dim = true;
      }
      const image = keyImage(opts);
      if (image === entry.lastImage) {
        return;
      }
      entry.lastImage = image;
      if (entry.action.isKey()) {
        await entry.action.setImage(image);
      } else if (entry.action.isDial()) {
        const vol = uuids.length ? averageVolume(uuids) : 0;
        await entry.action.setFeedback({
          title: opts.title,
          icon: image,
          value: uuids.length ? `${vol}` : "–",
          indicator: { value: vol, enabled: uuids.length > 0 },
        });
      }
    } catch (e) {
      logger.warn(`render failed: ${describeError(e)}`);
    }
  }

  /** Runs a command for a key press: alert on failure, re-render afterwards. */
  protected async run(a: Action<T>, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (e) {
      logger.error(`command failed: ${describeError(e)}`);
      if (a.isKey() || a.isDial()) await a.showAlert();
      void sonos.refreshTopology();
    }
    this.renderAll();
  }
}

function averageVolume(uuids: string[]): number {
  const known = uuids.map((u) => sonos.volume.get(u)).filter((v): v is number => typeof v === "number");
  return known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : 0;
}

// ---- Play / Pause -------------------------------------------------------------------------------

type PlaybackSettings = TargetSettings & {
  command?: "toggle" | "play" | "pause" | "stop" | "next" | "previous";
}

@action({ UUID: "com.igorstefus.sonos.playback" })
class PlaybackAction extends SonosAction<PlaybackSettings> {
  protected image(s: PlaybackSettings, uuids: string[]): KeyImageOptions {
    const playing = uuids.some((u) => sonos.isPlaying(u));
    const command = s.command ?? "toggle";
    const glyph: Glyph = command === "toggle" ? (playing ? "pause" : "play") : command;
    return { title: targetTitle(s, uuids), glyph, bar: playing ? GREEN : undefined };
  }

  override async onKeyDown(ev: KeyDownEvent<PlaybackSettings>): Promise<void> {
    const s = ev.payload.settings;
    const uuids = targets(s);
    if (uuids.length === 0) {
      await ev.action.showAlert();
      return;
    }
    await this.run(ev.action, async () => {
      switch (s.command ?? "toggle") {
        case "play":
          return sonos.transportCommand(uuids, "Play");
        case "pause":
          return sonos.transportCommand(uuids, "Pause");
        case "stop":
          return sonos.transportCommand(uuids, "Stop");
        case "next":
          return sonos.transportCommand(uuids, "Next");
        case "previous":
          return sonos.transportCommand(uuids, "Previous");
        default:
          return sonos.togglePlayPause(uuids);
      }
    });
  }
}

// ---- Group --------------------------------------------------------------------------------------

type GroupSettings = TargetSettings & {
  mode?: "toggle" | "group" | "ungroup";
  /** Speaker that leads the group (its queue keeps playing); empty = pick automatically. */
  coordinator?: string;
}

/** Coordinator each room last left through a single-room toggle key, so the next press can put it back. */
const lastLeft = new Map<string, string>();

@action({ UUID: "com.igorstefus.sonos.group" })
class GroupAction extends SonosAction<GroupSettings> {
  /** The dedicated Ungroup action overrides this; the Group action reads the mode from its settings. */
  protected modeOf(s: GroupSettings): "toggle" | "group" | "ungroup" {
    return s.mode ?? "toggle";
  }

  /**
   * The coordinator a lone room joins when its toggle key is pressed: the lead speaker from the settings,
   * else the group it last left with this plugin, else the one other group that is playing right now.
   */
  protected joinTargetFor(room: string, s: GroupSettings): Speaker | undefined {
    const candidate = (uuid?: string): Speaker | undefined => {
      const c = uuid ? sonos.coordinatorOf(uuid) : undefined;
      return c && c.uuid !== room ? c : undefined;
    };
    const lead = candidate(s.coordinator || undefined);
    if (lead) return lead;
    const previous = candidate(lastLeft.get(room));
    if (previous) return previous;
    const playing = sonos.speakers.filter((sp) => sp.coordinator === sp.uuid && sp.uuid !== room && sonos.transport.get(sp.uuid) === "PLAYING");
    return playing.length === 1 ? playing[0] : undefined;
  }

  protected image(s: GroupSettings, uuids: string[]): KeyImageOptions {
    const mode = this.modeOf(s);
    if (mode === "ungroup") {
      // Something to leave: any targeted room sits in a group with other rooms.
      const inGroup = uuids.some((u) => sonos.groupOf(u).length > 1);
      const subtitle = uuids.length === 0 ? undefined : inGroup ? (uuids.length === 1 ? "in group" : "grouped") : uuids.length === 1 ? "alone" : "separate";
      return { title: targetTitle(s, uuids), glyph: "unlink", subtitle, bar: inGroup ? GREEN : undefined };
    }
    if (mode === "toggle" && uuids.length === 1) {
      // One room: the toggle takes it out of its group, or puts it back into one (see joinTargetFor).
      const inGroup = sonos.groupOf(uuids[0]).length > 1;
      const join = inGroup ? undefined : this.joinTargetFor(uuids[0], s);
      const subtitle = inGroup ? "in group" : join ? `join ${join.name}` : "alone";
      return { title: targetTitle(s, uuids), glyph: inGroup ? "unlink" : "link", subtitle, bar: inGroup ? GREEN : undefined };
    }
    const grouped = sonos.isGrouped(uuids);
    const glyph: Glyph = mode === "group" ? "link" : grouped ? "unlink" : "link";
    const subtitle = uuids.length < 2 ? (uuids.length === 1 ? "pick 2 or more" : undefined) : grouped ? "grouped" : "separate";
    return { title: targetTitle(s, uuids), glyph, subtitle, bar: grouped ? GREEN : undefined };
  }

  override async onKeyDown(ev: KeyDownEvent<GroupSettings>): Promise<void> {
    const s = ev.payload.settings;
    const uuids = targets(s);
    const mode = this.modeOf(s);
    logger.info(`${mode} pressed for ${uuids.map((u) => sonos.speaker(u)?.name).join(", ") || "no rooms"} (all=${s.all === true}, ticked=${JSON.stringify(s.speakers ?? [])})`);
    const coordinator = s.coordinator || undefined;
    // Toggle with a single room: leave its group, or (when alone) join one.
    if (mode === "toggle" && uuids.length === 1) {
      const room = uuids[0];
      if (sonos.groupOf(room).length > 1) {
        lastLeft.set(room, sonos.coordinatorOf(room)?.uuid ?? "");
        await this.run(ev.action, () => sonos.ungroup(uuids));
        return;
      }
      const join = this.joinTargetFor(room, s);
      if (!join) {
        logger.info("nothing to join: pick a lead speaker in the key settings, or start playing on another room");
        await ev.action.showAlert();
        return;
      }
      await this.run(ev.action, () => sonos.group([room, join.uuid], join.uuid));
      return;
    }
    // Group needs two rooms; Ungroup takes one.
    if (uuids.length < (mode === "ungroup" ? 1 : 2)) {
      await ev.action.showAlert();
      return;
    }
    await this.run(ev.action, async () => {
      switch (mode) {
        case "group":
          return sonos.group(uuids, coordinator);
        case "ungroup":
          return sonos.ungroup(uuids);
        default:
          return sonos.toggleGroup(uuids, coordinator);
      }
    });
  }
}

/** Ungroup: every ticked room leaves its group and plays on its own. One room is enough. */
@action({ UUID: "com.igorstefus.sonos.ungroup" })
class UngroupAction extends GroupAction {
  protected override modeOf(): "ungroup" {
    return "ungroup";
  }
}

// ---- Volume -------------------------------------------------------------------------------------

type VolumeSettings = TargetSettings & {
  direction?: "up" | "down" | "mute";
  /** Volume change per press / per dial tick, 1-20. */
  step?: number | string;
}

function stepOf(s: VolumeSettings): number {
  const n = Number(s.step);
  return Number.isFinite(n) && n >= 1 ? Math.min(20, Math.round(n)) : 2;
}

@action({ UUID: "com.igorstefus.sonos.volume" })
class VolumeAction extends SonosAction<VolumeSettings> {
  protected image(s: VolumeSettings, uuids: string[]): KeyImageOptions {
    const direction = s.direction ?? "up";
    const muted = uuids.length > 0 && uuids.every((u) => sonos.mute.get(u));
    const glyph: Glyph = direction === "mute" ? "mute" : direction === "down" ? "volumeDown" : "volumeUp";
    const vol = averageVolume(uuids);
    const subtitle = uuids.length === 0 ? undefined : muted ? "muted" : uuids.length > 1 ? `~${vol}` : `${vol}`;
    return { title: targetTitle(s, uuids), glyph, subtitle, bar: muted ? RED : undefined };
  }

  override async onKeyDown(ev: KeyDownEvent<VolumeSettings>): Promise<void> {
    const s = ev.payload.settings;
    const uuids = targets(s);
    if (uuids.length === 0) {
      await ev.action.showAlert();
      return;
    }
    await this.run(ev.action, async () => {
      switch (s.direction ?? "up") {
        case "mute":
          return sonos.toggleMute(uuids);
        case "down":
          return sonos.setRelativeVolume(uuids, -stepOf(s));
        default:
          return sonos.setRelativeVolume(uuids, stepOf(s));
      }
    });
  }

  /** Stream Deck + dial: rotate changes volume by ticks x step, press or tap toggles mute. */
  override async onDialRotate(ev: DialRotateEvent<VolumeSettings>): Promise<void> {
    const s = ev.payload.settings;
    const uuids = targets(s);
    if (uuids.length === 0) return;
    await this.run(ev.action, () => sonos.setRelativeVolume(uuids, ev.payload.ticks * stepOf(s)));
  }

  override async onDialDown(ev: DialDownEvent<VolumeSettings>): Promise<void> {
    const uuids = targets(ev.payload.settings);
    if (uuids.length === 0) return;
    await this.run(ev.action, () => sonos.toggleMute(uuids));
  }

  override async onTouchTap(ev: TouchTapEvent<VolumeSettings>): Promise<void> {
    const uuids = targets(ev.payload.settings);
    if (uuids.length === 0) return;
    await this.run(ev.action, () => sonos.toggleMute(uuids));
  }
}

// ---- Property inspector data source --------------------------------------------------------------

/** sdpi-components data source: the property inspector asks for `speakers`, we answer with the current rooms. */
streamDeck.ui.onSendToPlugin(async (ev) => {
  const payload = (ev.payload ?? {}) as { event?: unknown; isRefresh?: unknown };
  const event = typeof payload.event === "string" ? payload.event : "";
  if (event === "speakers" || event === "coordinators") {
    if (sonos.speakers.length === 0 || payload.isRefresh === true) {
      await sonos.discover();
      await sonos.refreshTopology();
    }
    const items = sonos.speakers.map((s) => ({ label: s.name, value: s.uuid }));
    if (items.length === 0) {
      items.push({ label: sonos.lastError ? "No Sonos speakers found: check the network or enter a speaker IP" : "Searching…", value: "" });
    }
    await streamDeck.ui.sendToPropertyInspector({ event, items });
  } else if (event === "rescan") {
    await sonos.discover();
    await sonos.refreshTopology();
  }
});

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => applyGlobalSettings(ev.settings));

streamDeck.actions.registerAction(new PlaybackAction());
streamDeck.actions.registerAction(new GroupAction());
streamDeck.actions.registerAction(new UngroupAction());
streamDeck.actions.registerAction(new VolumeAction());

await streamDeck.connect();
applyGlobalSettings(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
sonos.start();
logger.info("Sonos plugin started");
