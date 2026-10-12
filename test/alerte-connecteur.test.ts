import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// `/alerte` through the real connector: the questions run in a DM, the room
// is created once the answers are confirmed, and the command is heard from
// anywhere while every other command keeps its gates. The rooms and the alert
// settings are read from the environment when config is first imported, so
// they are set before the dynamic import below, with a throwaway data
// directory for the history and the created-rooms record.
const BOT = "@bot:hs";
const USER = "@agent:hs";
const AUTORISE = "!autorise:hs";
const COMMANDES = "!commandes:hs";
const OPS = "!ops:hs";
const AILLEURS = "!ailleurs:hs";
const MP = "!mp:hs";
// A one-to-one room with the bot that its m.direct does not list.
const TETE_A_TETE = "!tete-a-tete:hs";
const ANNONCE = "!annonce:hs";

const dataDir = mkdtempSync(path.join(tmpdir(), "betabot-test-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));
process.env["DATA_DIR"] = dataDir;
process.env["MATRIX_ALLOWED_ROOMS"] = [AUTORISE, COMMANDES, OPS].join(",");
process.env["MATRIX_COMMAND_ROOMS"] = COMMANDES;
process.env["MATRIX_OPS_ROOMS"] = OPS;
process.env["MATRIX_DM_TEST_USERS"] = "";
process.env["ALERTE_SECU_REFERENTS"] = "@ref:hs";
process.env["ALERTE_SECU_ROOM"] = ANNONCE;
const { MatrixConnector } = await import("../src/connectors/matrix.js");

interface Envoi {
  roomId: string;
  type: string;
  content: { body?: string };
}

// Room ids handed out by the fake homeservers, unique across the tests: the
// created-rooms record is shared by the whole file, as it is by a real bot.
let derniereSalle = 0;

// A connector wired to a fake client, as if start() had run. The DM with the
// user is MP.
function connecteur() {
  const envois: Envoi[] = [];
  const salons: string[] = [];
  const ids: string[] = [];
  const client = {
    async sendEvent(roomId: string, type: string, content: Envoi["content"]) {
      envois.push({ roomId, type, content });
      return "$ev";
    },
    async createRoom(props: { name: string }) {
      salons.push(props.name);
      ids.push(`!alerte${++derniereSalle}:hs`);
      return ids.at(-1)!;
    },
    async inviteUser() {},
    async getRoomStateEvent(_roomId: string, type: string) {
      if (type === "m.room.power_levels") return { users: { [BOT]: 100 } };
      throw { errcode: "M_NOT_FOUND" };
    },
    async sendStateEvent() {
      return "$pl";
    },
    dms: { getOrCreateDm: async () => MP },
    // Every room holds a third person, except the one-to-one rooms.
    async getJoinedRoomMembers(roomId: string) {
      return roomId === TETE_A_TETE || roomId === MP
        ? [BOT, USER]
        : [BOT, USER, "@autre:hs"];
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = new MatrixConnector() as any;
  c.client = client;
  c.ownUserId = BOT;
  c.ownDisplayName = "Bot";
  c.startupTs = 0;
  c.dmRooms.add(MP);
  // What the bot wrote in `roomId` (reactions aside).
  const messages = (roomId: string) =>
    envois
      .filter((e) => e.roomId === roomId && e.type === "m.room.message")
      .map((e) => e.content.body ?? "");
  const dernier = (roomId: string) => messages(roomId).at(-1) ?? "";
  const recoit = (roomId: string, body: string, mention = roomId !== MP) =>
    c.handleIncomingMessage(roomId, message(body, mention)) as Promise<void>;
  return { c, salons, ids, messages, dernier, recoit };
}

let n = 0;
// A message from an ordinary user; `mention` makes it a real pill of the bot.
function message(body: string, mention: boolean) {
  return {
    sender: USER,
    event_id: `$m${++n}`,
    origin_server_ts: Date.now(),
    content: mention
      ? {
          msgtype: "m.text",
          body: `${BOT} ${body}`,
          format: "org.matrix.custom.html",
          formatted_body: `<a href="https://matrix.to/#/${BOT}">Bot</a> ${body}`,
        }
      : { msgtype: "m.text", body },
  };
}

const REPONSES = [
  "RCE sans authentification via l'API publique.",
  "9.8",
  "CVE-2026-1234",
  "oui",
  "non",
  "< 1.50.3",
  "https://example.org/advisory",
  "-",
];

test("en MP : questions, récapitulatif, puis salon créé sur oui", async () => {
  const b = connecteur();
  await b.recoit(MP, "/alerte");
  assert.match(b.dernier(MP), /Question 1\/9/);
  await b.recoit(MP, "composant-a");
  assert.match(b.dernier(MP), /Question 2\/9/);
  for (const r of REPONSES) await b.recoit(MP, r);
  // An answer never draws the generic "command bot" notice.
  assert.ok(!b.messages(MP).some((m) => /bot \*\*à commandes\*\*/.test(m)));
  assert.match(b.dernier(MP), /Voici le message qui ouvrira le salon/);
  assert.deepEqual(b.salons, []);

  await b.recoit(MP, "oui");
  assert.equal(b.salons.length, 1);
  assert.match(b.salons[0]!, /^tmp-alerte-securite-composant-a-\d{6}$/);
  const [ouverture] = b.messages(b.ids[0]!);
  assert.match(ouverture ?? "", /Pourquoi tu es invité·e[\s\S]*RCE sans authentification/);
  assert.match(b.messages(ANNONCE)[0] ?? "", /^@room /);
  assert.match(b.dernier(MP), /Alerte \*\*composant-a\*\* lancée/);
});

test("en MP : annuler abandonne sans rien créer", async () => {
  const b = connecteur();
  await b.recoit(MP, "/alerte composant-b");
  await b.recoit(MP, "annuler");
  assert.match(b.dernier(MP), /Alerte annulée/);
  await b.recoit(MP, "RCE");
  // No conversation any more: a plain message gets the generic notice.
  assert.match(b.dernier(MP), /bot \*\*à commandes\*\*/);
  assert.deepEqual(b.salons, []);
});

test("même composant le même jour : pas de questions, invitation dans le salon ouvert", async () => {
  const b = connecteur();
  await b.recoit(MP, "/alerte composant-c");
  for (const r of REPONSES) await b.recoit(MP, r);
  await b.recoit(MP, "oui");
  await b.recoit(MP, "/alerte composant-c");
  assert.match(b.dernier(MP), /déjà ouverte aujourd'hui/);
  assert.equal(b.salons.length, 1);
});

test("même composant donné en réponse : le bot s'arrête là et invite dans le salon ouvert", async () => {
  const b = connecteur();
  await b.recoit(MP, "/alerte composant-d");
  for (const r of REPONSES) await b.recoit(MP, r);
  await b.recoit(MP, "oui");
  await b.recoit(MP, "/alerte");
  await b.recoit(MP, "Composant-D");
  assert.match(b.dernier(MP), /déjà ouverte aujourd'hui/);
  // The conversation is over: the next message is not taken as an answer.
  await b.recoit(MP, "RCE");
  assert.match(b.dernier(MP), /bot \*\*à commandes\*\*/);
});

test("l'historique du bot ne garde pas la description de la faille", async () => {
  const b = connecteur();
  await b.recoit(MP, "/alerte composant-e");
  for (const r of REPONSES) await b.recoit(MP, r);
  await b.recoit(MP, "oui");
  const historique = readFileSync(path.join(dataDir, "command-history.json"), "utf-8");
  assert.match(historique, /alerte/);
  assert.doesNotMatch(historique, /RCE sans authentification|CVE-2026-1234|example\.org/);
});

test("un tête-à-tête absent de m.direct est un MP : /alerte seul y pose ses questions, sur place", async () => {
  const b = connecteur();
  await b.recoit(TETE_A_TETE, "/alerte", false);
  assert.match(b.dernier(TETE_A_TETE), /Question 1\/9/);
  assert.deepEqual(b.messages(MP), []);
  await b.recoit(TETE_A_TETE, "composant-f", false);
  assert.match(b.dernier(TETE_A_TETE), /Question 2\/9/);
});

test("en MP, /alerte marche aussi précédé d'une mention", async () => {
  const b = connecteur();
  await b.recoit(TETE_A_TETE, "/alerte", true);
  assert.match(b.dernier(TETE_A_TETE), /Question 1\/9/);
  assert.deepEqual(b.messages(MP), []);
});

test("partout : hors MATRIX_ALLOWED_ROOMS, seule l'alerte est entendue, et les questions passent en MP", async () => {
  const b = connecteur();
  await b.recoit(AILLEURS, "/help");
  assert.deepEqual(b.messages(AILLEURS), []);
  await b.recoit(AILLEURS, "/alerte");
  assert.match(b.dernier(AILLEURS), /Je t'écris en MP/);
  assert.match(b.dernier(MP), /Question 1\/9/);
});

test("partout : depuis un salon OPS", async () => {
  const b = connecteur();
  await b.recoit(OPS, "/alerte");
  assert.match(b.dernier(MP), /Question 1\/9/);
});

test("partout : un salon autorisé hors salon de commandes refuse /salon, pas /alerte", async () => {
  const b = connecteur();
  await b.recoit(AUTORISE, "/salon list");
  assert.match(b.dernier(AUTORISE), /n'est pas autorisée dans ce salon/);
  await b.recoit(AUTORISE, "/alerte");
  assert.match(b.dernier(MP), /Question 1\/9/);
});

test("partout : en MP, un utilisateur ordinaire passe la garde du salon de commandes", async () => {
  const b = connecteur();
  await b.recoit(MP, "/salon list");
  assert.match(b.dernier(MP), /n'est pas autorisée dans ce salon/);
  await b.recoit(MP, "/alerte");
  assert.match(b.dernier(MP), /Question 1\/9/);
});

// Not an /alerte test as such, but it rides on the same harness: a bot back
// after downtime replays old history, and must not apologise for each old
// message it cannot decrypt.
test("un vieux message indéchiffrable, rejoué au démarrage, ne déclenche pas d'excuse", async () => {
  const b = connecteur();
  b.c.startupTs = Date.now() - 60_000;
  const indechiffrable = (ts: number) => ({
    sender: USER,
    event_id: `$chiffre${++n}`,
    origin_server_ts: ts,
    content: {},
  });
  await b.c.handleFailedDecryption(MP, indechiffrable(Date.now() - 86_400_000), new Error("clé absente"));
  assert.deepEqual(b.messages(MP), []);
  await b.c.handleFailedDecryption(MP, indechiffrable(Date.now()), new Error("clé absente"));
  assert.match(b.dernier(MP), /pas pu déchiffrer/);
});

test("sans mention, un message en salon reste sans réponse", async () => {
  const b = connecteur();
  await b.recoit(AILLEURS, "/alerte", false);
  assert.deepEqual(b.messages(AILLEURS), []);
  assert.deepEqual(b.messages(MP), []);
});
