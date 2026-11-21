# Tapo Matter Bridge

A Home Assistant add-on that gets Tapo S200B button presses and turns straight
from the Tapo hub over Matter, on the LAN, with no cloud.

The add-on gives itself a Matter light per button, joins Home Assistant's
Matter fabric and binds each button on the hub to its light. Every command the
button sends then becomes a `tapo_button_matter` event in Home Assistant.

## Needs

- The Tapo hub (H100) added to Home Assistant's Matter (Matter Server add-on).
- The Matter Server add-on's `enable_test_net_dcl` option on: the bridge is a
  test-vendor Matter device.

## Install

1. Settings → Add-ons → Add-on store → ⋮ → Repositories: add
   `https://github.com/Schalk-Christiaan/tapo-matter-bridge`.
2. Install **Tapo Matter Bridge** and start it. Its log names each button it bound.
3. Hide the light entities it creates: they only receive the commands.

Restart the add-on after adding a button to the hub.

## Event

`tapo_button_matter`:

| Field | Value |
|---|---|
| `serial` | the button's serial (its MAC), e.g. `EC750C8999FB` |
| `kind` | `single_press`, `rotate_right` or `rotate_left` |
| `degrees` | turns only: degrees for this click, negative to the left |

```yaml
triggers:
  - trigger: event
    event_type: tapo_button_matter
    event_data: { serial: EC750C8999FB, kind: single_press }
actions:
  - action: light.toggle
    target: { entity_id: light.l530_2 }
```

## What the S200B doesn't send over Matter

Double presses. The hub only records them in its own log.
