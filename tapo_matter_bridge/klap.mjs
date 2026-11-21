// Minimal KLAP v2 client for a Tapo hub (Third-Party Compatibility on), enough to read trigger logs.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { request as http } from "node:http";

const sha = (alg, ...parts) => createHash(alg).update(Buffer.concat(parts)).digest();

// The hub's web server answers fetch()'s extra headers with HTTP 400, so plain http with only what it needs
const post = (url, body, cookie) => new Promise((ok, fail) => {
  const headers = { "Content-Length": body.length, ...(cookie && { Cookie: cookie }) };
  const req = http(url, { method: "POST", headers, timeout: 5000 }, res => {
    const chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => res.statusCode === 200
      ? ok({ body: Buffer.concat(chunks), cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0] })
      : fail(new Error(`${url.split("?")[0]}: HTTP ${res.statusCode}`)));
  });
  req.on("timeout", () => req.destroy(new Error(`${url}: timeout`)));
  req.on("error", fail);
  req.end(body);
});

export async function klap(host, username, password) {
  const auth = sha("sha256", sha("sha1", Buffer.from(username)), sha("sha1", Buffer.from(password)));
  const local = randomBytes(16);
  const { body: b1, cookie } = await post(`http://${host}/app/handshake1`, local);
  const remote = b1.subarray(0, 16);
  if (!sha("sha256", local, remote, auth).equals(b1.subarray(16, 48)))
    throw new Error("KLAP: wrong Tapo username or password");
  await post(`http://${host}/app/handshake2`, sha("sha256", remote, local, auth), cookie);

  const seed = Buffer.concat([local, remote, auth]);
  const key = sha("sha256", Buffer.from("lsk"), seed).subarray(0, 16);
  const ivs = sha("sha256", Buffer.from("iv"), seed);
  const sig = sha("sha256", Buffer.from("ldk"), seed).subarray(0, 28);
  let seq = ivs.readInt32BE(28);
  const iv = s => { const b = Buffer.alloc(16); ivs.copy(b, 0, 0, 12); b.writeInt32BE(s, 12); return b; };

  return async function request(method, params) {
    seq = seq === 0x7fffffff ? -0x80000000 : seq + 1;
    const s = seq, sb = Buffer.alloc(4);
    sb.writeInt32BE(s);
    const c = createCipheriv("aes-128-cbc", key, iv(s));
    const enc = Buffer.concat([c.update(JSON.stringify({ method, params })), c.final()]);
    const r = await post(`http://${host}/app/request?seq=${s}`, Buffer.concat([sha("sha256", sig, sb, enc), enc]), cookie);
    const d = createDecipheriv("aes-128-cbc", key, iv(s));
    const body = r.body.subarray(32);
    const res = JSON.parse(Buffer.concat([d.update(body), d.final()]).toString());
    if (res.error_code) throw new Error(`${method}: error ${res.error_code}`);
    return res.result;
  };
}
