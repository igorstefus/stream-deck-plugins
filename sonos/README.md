# Sonos Stream Deck plugin

Controls Sonos speakers on the local network straight from a Stream Deck. No Sonos account or cloud API:
the plugin finds the players with SSDP and talks to them over their local UPnP/SOAP interface.

## Actions

Every action has a speaker picker in its settings: tick one room, several rooms, or **All speakers**.

| Action | What it does |
| --- | --- |
| Play / Pause | Toggle (pauses when anything targeted is playing, else plays), or a fixed Play, Pause, Stop, Next, Previous. Commands go to the group each room belongs to. The key shows a green bar while playing. |
| Group | Joins the ticked rooms into one group (toggle: ungroups them when they are already together). Optional lead speaker whose queue the group plays; otherwise a playing room, else the first. |
| Ungroup | Each ticked room leaves its group and plays on its own. One room is enough; All splits every group. |
| Volume | Up, down or mute for the ticked rooms, with a step of 1-20. Several rooms on one key are equalized: each press sets them all to the quietest one plus or minus the step. Rooms under **Keep own level** are not equalized but move by the step with the others. The key shows the level now and the level a press lands on (10→12). On a Stream Deck + dial: turn for volume, press or tap for mute. |

Speakers are remembered by their Sonos id, so IP changes do not break keys. Surround satellites, subs and
Boost/Bridge devices are never listed. If multicast discovery is blocked on your network, enter the IP of any
one speaker in the **Speaker IP** field of any key (it is a global setting).

## Development

```
npm install
npm run assets      # regenerate PNG icons (needs Python + Pillow)
npm run build       # bundle src/ into com.igorstefus.sonos.sdPlugin/bin/plugin.js
npm run link        # symlink the .sdPlugin folder into Stream Deck (once)
npm run restart     # restart the plugin in Stream Deck after a build
npm run watch       # rebuild and restart on every change
npm run validate    # streamdeck validate
npm run pack        # build a .streamDeckPlugin installer
```

Logs: `com.igorstefus.sonos.sdPlugin/logs/`. Requires Stream Deck 7.1 or newer (SDK 3 settings behaviour).

### Layout

- `src/sonos.ts`: discovery (SSDP), zone group topology, transport/volume polling and the commands.
- `src/images.ts`: key images rendered as SVG data URLs.
- `src/plugin.ts`: the three actions, the shared target/watch plumbing and the property inspector data source.
- `com.igorstefus.sonos.sdPlugin/ui/*.html`: settings panels (sdpi-components).
- `tools/make-assets.py`: static icons.
