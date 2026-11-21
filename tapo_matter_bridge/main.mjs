// Tapo Matter Bridge: a Matter light per S200B button that the Tapo hub is bound to.
// A bound S200B sends Toggle on a press and Step on each turn click; each command
// becomes a tapo_button_matter event in Home Assistant. Double presses never come
// over Matter: the hub only records them in its own log, which this add-on reads
// over KLAP when the Tapo login is set.
import { Endpoint, ServerNode, VendorId } from "@matter/main";
import { DimmableLightDevice } from "@matter/main/devices";
import { LevelControlServer, OnOffServer } from "@matter/main/behaviors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { klap } from "./klap.mjs";

const MATTER_WS = process.env.MATTER_WS ?? "ws://127.0.0.1:5580/ws"; // HA's Matter Server add-on
const HA_EVENT = process.env.HA_EVENT_URL ?? "http://supervisor/core/api/events/tapo_button_matter";
const STATE = `${process.env.MATTER_STORAGE_PATH ?? "."}/bridge.json`;
const OPTIONS = process.env.OPTIONS_PATH ?? "/data/options.json"; // add-on settings from HA
const DIMMER_SWITCH = 260;

const send = (serial, kind, degrees) =>
  fetch(HA_EVENT, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ serial: serial.toUpperCase(), kind, degrees }),
  }).then(r => r.ok || console.error("HA event failed", r.status), e => console.error("HA event failed", e.message));

class PressServer extends OnOffServer {
  toggle() {
    send(this.endpoint.id, "single_press");
    return super.toggle();
  }
}

class TurnServer extends LevelControlServer {
  step(request) {
    const up = request.stepMode === 0;
    send(this.endpoint.id, up ? "rotate_right" : "rotate_left", up ? request.stepSize : -request.stepSize);
    return super.step(request);
  }
}

async function matterServer(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.onmessage = ok; ws.onerror = () => fail(new Error(`no Matter Server at ${url}`)); });
  const pending = new Map();
  let n = 0;
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.message_id);
    if (!p) return;
    pending.delete(m.message_id);
    "error_code" in m ? p.fail(new Error(`${p.command}: ${m.error_code} ${m.details ?? ""}`)) : p.ok(m.result);
  };
  return {
    call: (command, args = {}) => new Promise((ok, fail) => {
      const id = String(++n);
      pending.set(id, { ok, fail, command });
      ws.send(JSON.stringify({ message_id: id, command, args }));
    }),
    close: () => ws.close(),
  };
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const matter = await matterServer(MATTER_WS);

// The hub's buttons: bridged endpoints of type Dimmer Switch, named by serial (= the button's MAC)
const buttons = [];
for (const node of await matter.call("get_nodes")) {
  if (node.node_id === state.nodeId) continue;
  const a = node.attributes;
  for (const key of Object.keys(a).filter(k => k.endsWith("/29/0"))) {
    const ep = Number(key.split("/")[0]);
    if (a[key].some(t => t["0"] === DIMMER_SWITCH) && a[`${ep}/57/15`])
      buttons.push({ hub: node.node_id, ep, serial: a[`${ep}/57/15`].toLowerCase(), name: a[`${ep}/57/5`] });
  }
}
if (!buttons.length) throw new Error("No Tapo buttons in Matter: add the Tapo hub to HA's Matter first");

const node = await ServerNode.create({
  id: "tapo-bridge",
  network: { port: 5541 },
  productDescription: { name: "Tapo Matter Bridge", deviceType: DimmableLightDevice.deviceType },
  basicInformation: {
    vendorName: "Tapo Matter Bridge", vendorId: VendorId(0xfff1), productId: 0x8000,
    nodeLabel: "Tapo Matter Bridge", productName: "Tapo Matter Bridge", productLabel: "Tapo Matter Bridge",
    serialNumber: "tapo-bridge", uniqueId: "tapo-bridge",
  },
});
const endpoints = new Map();
for (const b of buttons) {
  const ep = new Endpoint(DimmableLightDevice.with(PressServer, TurnServer), { id: b.serial });
  await node.add(ep);
  endpoints.set(b.serial, ep);
}
await node.start();

if (!node.lifecycle.isCommissioned || !state.nodeId) {
  const code = node.state.commissioning.pairingCodes.manualPairingCode;
  console.log("Joining HA's Matter fabric");
  state.nodeId = (await matter.call("commission_with_code", { code, network_only: true })).node_id;
  writeFileSync(STATE, JSON.stringify(state));
}

// Let the hubs send commands to us, next to HA's own admin entries
const hubs = [...new Set(buttons.map(b => b.hub))];
const read = await matter.call("read_attribute", { node_id: state.nodeId, attribute_path: "0/31/0" });
const acl = Array.isArray(read) ? read : read["0/31/0"];
const admins = acl.filter(e => e["1"] === 5).map(e => ({ privilege: 5, authMode: e["2"], subjects: e["3"], targets: e["4"] }));
await matter.call("write_attribute", {
  node_id: state.nodeId, attribute_path: "0/31/0",
  value: [...admins, { privilege: 3, authMode: 2, subjects: hubs, targets: null }],
});

// ponytail: a button added later needs an add-on restart to get its endpoint and binding
for (const b of buttons) {
  const target = { node: state.nodeId, group: null, endpoint: endpoints.get(b.serial).number };
  await matter.call("set_node_binding", {
    node_id: b.hub, endpoint: b.ep,
    bindings: [{ ...target, cluster: 6 }, { ...target, cluster: 8 }],
  });
  console.log(`Bound ${b.name} (${b.serial}) to endpoint ${target.endpoint}`);
}
matter.close();
console.log("Ready");

// Double presses: poll each button's trigger log on the hub
const opt = existsSync(OPTIONS) ? JSON.parse(readFileSync(OPTIONS, "utf8")) : {};
if (!opt.tapo_hub || !opt.tapo_username || !opt.tapo_password) {
  console.log("No Tapo hub login in the settings: double presses off");
} else {
  for (;;) {
    try {
      const req = await klap(opt.tapo_hub, opt.tapo_username, opt.tapo_password);
      const kids = (await req("get_child_device_list", { start_index: 0 })).child_device_list;
      const watch = kids.filter(c => endpoints.has(c.mac?.toLowerCase()));
      const logs = async c => (await req("control_child", {
        device_id: c.device_id, requestData: { method: "get_trigger_logs", params: { start_id: 0 } },
      })).responseData.result.logs ?? [];
      const last = new Map();
      for (const c of watch) last.set(c.device_id, Math.max(0, ...(await logs(c)).map(e => e.id)));
      console.log(`Reading double presses from the hub log of ${watch.length} buttons`);
      for (;;) {
        for (const c of watch) {
          // ponytail: only the newest 10 entries; 10+ log entries per button in one poll would drop some
          const fresh = (await logs(c)).filter(e => e.id > last.get(c.device_id));
          if (!fresh.length) continue;
          last.set(c.device_id, Math.max(...fresh.map(e => e.id)));
          for (const e of fresh) if (e.event === "doubleClick") send(c.mac, "double_press");
        }
        await sleep(200);
      }
    } catch (e) {
      console.error("Tapo hub:", e.message, "- retrying in 10 s");
      await sleep(10_000);
    }
  }
}
