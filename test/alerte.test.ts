import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ConversationsAlerte,
  isAlerteCommand,
  parseAlerte,
  nomSalonAlerte,
  buildAlerteHelp,
  ficheAlerte,
  annonceAlerte,
  recapAlerte,
  lancerAlerteSecu,
  type AlerteClient,
  type AlerteDeps,
  type InfosAlerte,
  type Mentions,
} from "../src/commands/alerte.js";

const BOT = "@bot:hs";
const LANCEUR = "@lanceur:hs";
const REF1 = "@ref1:hs";
const REF2 = "@ref2:hs";
const ANNONCE = "!domainesecu:hs";
const DM = "!dm:hs";
const NOW = new Date("2026-09-28T10:00:00Z");

// A literal "@room" notifies the whole room a message is posted in; only the
// announcement may carry one.
const AT_ROOM = /(^|[^\w])@room\b/;

const INFOS: InfosAlerte = {
  composant: "Metabase",
  resume: "RCE sans authentification via l'API publique.",
  cvss: "9.8",
  cve: "CVE-2026-1234",
  exploitee: "oui",
  patch: "inconnu",
  versions: "< 1.50.3",
  lien: "https://metabase.com/security/advisory",
};

// ─── Command ─────────────────────────────────────────────────────────────────

test("isAlerteCommand: /alerte, nothing else", () => {
  assert.ok(isAlerteCommand("/alerte"));
  assert.ok(isAlerteCommand("/Alerte metabase"));
  for (const t of ["/alerte-secu x", "/alertes", "/invite x"]) {
    assert.equal(isAlerteCommand(t), false, t);
  }
});

test("parseAlerte: start, with or without the component", () => {
  assert.deepEqual(parseAlerte("/alerte"), { kind: "demarrer" });
  assert.deepEqual(parseAlerte('/alerte "Apache Tomcat"'), {
    kind: "demarrer",
    composant: "Apache Tomcat",
  });
});

test("parseAlerte: help, cancel, and refusals", () => {
  assert.equal(parseAlerte("/alerte help").kind, "aide");
  assert.equal(parseAlerte("/alerte aide").kind, "aide");
  assert.equal(parseAlerte("/alerte annuler").kind, "annuler");
  const option = parseAlerte("/alerte metabase --simuler");
  assert.equal(option.kind, "erreur");
  assert.match(option.kind === "erreur" ? option.message : "", /--simuler/);
  assert.equal(parseAlerte("/alerte !!!").kind, "erreur");
});

test("nomSalonAlerte: the procedure's naming, dated in Paris", () => {
  assert.equal(nomSalonAlerte("Metabase", NOW), "tmp-alerte-securite-metabase-280926");
  assert.equal(
    nomSalonAlerte("Apache Tomcat (Élevée)", NOW),
    "tmp-alerte-securite-apache-tomcat-elevee-280926",
  );
  // 00:30 in Paris is still the previous day in UTC, in summer and in winter.
  assert.match(nomSalonAlerte("x", new Date("2026-09-27T22:30:00Z")), /-280926$/);
  assert.match(nomSalonAlerte("x", new Date("2026-12-31T23:30:00Z")), /-010127$/);
});

// ─── Questions ───────────────────────────────────────────────────────────────

test("questions: the whole path, answers normalised, launched on oui", () => {
  const c = new ConversationsAlerte();
  assert.match(c.demarrer(LANCEUR, DM, 0), /9 questions[\s\S]*Question 1\/9/);
  const composant = c.repondre(LANCEUR, "Metabase", 1);
  assert.deepEqual(composant.kind === "composant" && composant.composant, "Metabase");
  const reponses = [
    "RCE sans authentification via l'API publique.",
    "9,8",
    "cve-2026-1234 puis CVE-2026-1234",
    "o",
    "?",
    "< 1.50.3",
    "voir https://metabase.com/security/advisory.",
  ];
  for (const [i, r] of reponses.entries()) {
    const s = c.repondre(LANCEUR, r, 2 + i);
    assert.equal(s.kind, "question", r);
    assert.match(s.kind === "question" ? s.message : "", new RegExp(`Question ${i + 3}/9`));
  }
  const recap = c.repondre(LANCEUR, "-", 10);
  assert.equal(recap.kind, "recap");
  const lance = c.repondre(LANCEUR, "oui", 11);
  assert.deepEqual(lance, { kind: "lancer", infos: INFOS });
  assert.equal(c.enCours(LANCEUR, DM, 12), false);
});

test("questions: a component given with the command skips its question", () => {
  const c = new ConversationsAlerte();
  assert.match(c.demarrer(LANCEUR, DM, 0, "log4j"), /8 questions[\s\S]*Question 2\/9/);
});

test("questions: a wrong answer is asked again, with the reason", () => {
  const c = new ConversationsAlerte();
  c.demarrer(LANCEUR, DM, 0, "metabase");
  const encore = (r: string, raison: RegExp, question: RegExp) => {
    const s = c.repondre(LANCEUR, r, 1);
    assert.equal(s.kind, "question", r);
    const m = s.kind === "question" ? s.message : "";
    assert.match(m, raison, r);
    assert.match(m, question, r);
  };
  encore("-", /une phrase au moins/, /Question 2\/9/);
  c.repondre(LANCEUR, "Contournement de l'authentification.", 1);
  encore("12", /de 0 à 10/, /Question 3\/9/);
  c.repondre(LANCEUR, "9.1", 1);
  encore("1234", /CVE-2026-1234/, /Question 4\/9/);
  c.repondre(LANCEUR, "-", 1);
  encore("peut-être", /`oui`, `non` ou `inconnu`/, /Question 5\/9/);
  c.repondre(LANCEUR, "non", 1);
  c.repondre(LANCEUR, "oui", 1);
  c.repondre(LANCEUR, "-", 1);
  encore("voir le site", /https:\/\//, /Question 8\/9/);
});

test("questions: annuler stops at any step, non at the confirmation too", () => {
  const c = new ConversationsAlerte();
  c.demarrer(LANCEUR, DM, 0);
  assert.equal(c.repondre(LANCEUR, "Annuler", 1).kind, "annulee");
  assert.equal(c.enCours(LANCEUR, DM, 2), false);

  c.demarrer(LANCEUR, DM, 0, "metabase");
  for (const r of ["Faille critique.", "-", "-", "non", "non", "-", "-", "-"]) {
    c.repondre(LANCEUR, r, 1);
  }
  const attente = c.repondre(LANCEUR, "peut-être", 1);
  assert.match(attente.kind === "question" ? attente.message : "", /\*\*oui\*\*/);
  assert.equal(c.repondre(LANCEUR, "non", 1).kind, "annulee");
});

test("questions: expire after inactivity, and only answered in their DM", () => {
  const c = new ConversationsAlerte(1000);
  c.demarrer(LANCEUR, DM, 0);
  assert.equal(c.enCours(LANCEUR, "!autre:hs", 10), false);
  c.repondre(LANCEUR, "metabase", 900);
  assert.equal(c.enCours(LANCEUR, DM, 1500), true);
  assert.equal(c.enCours(LANCEUR, DM, 2000), false);
});

// ─── Messages ────────────────────────────────────────────────────────────────

test("ficheAlerte: why you are here, the flaw, what is expected", () => {
  const fiche = ficheAlerte(INFOS, LANCEUR, NOW);
  for (const attendu of [
    /Pourquoi tu es invité·e/,
    /\*\*Metabase\*\*/,
    /RCE sans authentification/,
    /Score CVSS\*\* : 9\.8/,
    /CVE\*\* : CVE-2026-1234/,
    /Exploitée dans la nature\*\* : \*\*Oui\*\*/,
    /Patch disponible\*\* : Inconnu/,
    /Versions vulnérables\*\* : < 1\.50\.3/,
    /Bulletin éditeur\*\* : https:\/\/metabase\.com/,
    /Aucune pour l'instant/,
    /Référents techs/,
    /Référents SSI/,
    /matrix\.to\/#\/@lanceur:hs/,
    /28\/09\/2026/,
  ]) {
    assert.match(fiche, attendu);
  }
  assert.doesNotMatch(fiche, AT_ROOM);
});

test("ficheAlerte: a passed question reads as not provided", () => {
  const fiche = ficheAlerte({ ...INFOS, cvss: undefined, lien: undefined }, LANCEUR, NOW);
  assert.match(fiche, /Score CVSS\*\* : _non renseigné_/);
  assert.match(fiche, /Bulletin éditeur\*\* : _non renseigné_/);
});

test("recapAlerte: the exact opening message, then oui / non", () => {
  const recap = recapAlerte({ infos: INFOS, lanceur: LANCEUR, now: NOW, nbReferents: 2, annonce: "~Domaine-secu" });
  assert.ok(recap.includes(ficheAlerte(INFOS, LANCEUR, NOW)));
  assert.match(recap, /tmp-alerte-securite-metabase-280926/);
  assert.match(recap, /toi \+ 2 référent\(s\)/);
  assert.match(recap, /\*\*oui\*\*/);
  assert.doesNotMatch(recap, /CVSS > 9\)\. Dans le doute/);
  assert.doesNotMatch(recap, AT_ROOM);
});

test("recapAlerte: warns when the score is below the procedure's threshold", () => {
  const recap = recapAlerte({ infos: { ...INFOS, cvss: "7.5" }, lanceur: LANCEUR, now: NOW, nbReferents: 0, annonce: null });
  assert.match(recap, /CVSS 7\.5 : la procédure vise/);
  assert.match(recap, /ALERTE_SECU_REFERENTS/);
  assert.match(recap, /ALERTE_SECU_ROOM/);
});

test("annonceAlerte: a live @room, the key facts and the room link", () => {
  const annonce = annonceAlerte(INFOS, LANCEUR, "!alerte:hs", "tmp-alerte-securite-metabase-280926");
  assert.match(annonce, /^@room /);
  assert.match(annonce, /\(CVSS 9\.8, CVE-2026-1234, exploitée dans la nature\)/);
  assert.match(annonce, /matrix\.to\/#\/!alerte%3Ahs/);
});

test("buildAlerteHelp: carries the handle, never a live @room", () => {
  const aide = buildAlerteHelp("@betabot+admin");
  assert.match(aide, /`@betabot\+admin \/alerte`/);
  assert.doesNotMatch(aide, AT_ROOM);
});

// ─── Launch ──────────────────────────────────────────────────────────────────

interface Fake {
  deps: AlerteDeps;
  // Everything the launch did, in order.
  seq: string[];
  created: Array<Record<string, unknown>>;
  posts: Array<{ roomId: string; markdown: string; mentions: Mentions }>;
  salons: Map<string, string>;
  // Contents of every m.room.power_levels the launch wrote.
  powerLevels: Array<Record<string, unknown>>;
}

function fake(
  over: Partial<AlerteDeps> = {},
  opts: {
    refuse?: string;
    rateLimitOnce?: string;
    createFails?: boolean;
    announceFails?: boolean;
    botLevelInAnnounce?: number;
  } = {},
): Fake {
  const seq: string[] = [];
  const created: Fake["created"] = [];
  const posts: Fake["posts"] = [];
  const salons = new Map<string, string>();
  const powerLevels: Fake["powerLevels"] = [];
  let limited = opts.rateLimitOnce;
  const client = {
    async createRoom(props: Record<string, unknown>) {
      if (opts.createFails) throw { errcode: "M_FORBIDDEN", error: "création interdite" };
      created.push(props);
      seq.push("create");
      return "!alerte:hs";
    },
    async inviteUser(userId: string, roomId: string) {
      if (userId === limited) {
        limited = undefined;
        throw { errcode: "M_LIMIT_EXCEEDED", retryAfterMs: 1 };
      }
      if (userId === opts.refuse) throw { errcode: "M_FORBIDDEN", error: "refusé" };
      seq.push(`invite ${userId} ${roomId}`);
    },
    async getRoomStateEvent(roomId: string, type: string) {
      if (roomId === ANNONCE && type === "m.room.name") return { name: "betagouv-domaine-secu" };
      if (roomId === ANNONCE && type === "m.room.power_levels")
        return { users: { [BOT]: opts.botLevelInAnnounce ?? 50 } };
      // What Tchap gives a new room: invitations reserved to moderators.
      if (type === "m.room.power_levels")
        return { users: { [BOT]: 100 }, invite: 50, state_default: 100 };
      throw { errcode: "M_NOT_FOUND" };
    },
    async sendStateEvent(_roomId: string, _type: string, _key: string, content: Record<string, unknown>) {
      powerLevels.push(content);
      seq.push("power_levels");
      return "$pl";
    },
  } as unknown as AlerteClient;
  return {
    seq,
    created,
    posts,
    salons,
    powerLevels,
    deps: {
      client,
      post: async (roomId, markdown, mentions) => {
        if (opts.announceFails && roomId === ANNONCE) throw new Error("pas membre");
        seq.push(`post ${roomId}`);
        posts.push({ roomId, markdown, mentions });
      },
      salons: {
        find: (name) => salons.get(name),
        add: (roomId, name) => void salons.set(name, roomId),
      },
      botUserId: BOT,
      lanceur: LANCEUR,
      infos: INFOS,
      now: NOW,
      referents: [REF1, REF2],
      annonceRoomId: ANNONCE,
      ...over,
    },
  };
}

test("lancer: a private, encrypted room whose history newcomers can read", async () => {
  const f = fake();
  const res = await lancerAlerteSecu(f.deps);
  assert.equal(res.reaction, "🚨");
  const room = f.created[0]!;
  assert.equal(room["name"], "tmp-alerte-securite-metabase-280926");
  assert.equal(room["preset"], "private_chat");
  const state = room["initial_state"] as Array<{ type: string; content: Record<string, unknown> }>;
  assert.ok(state.some((e) => e.type === "m.room.encryption"));
  assert.deepEqual(
    state.find((e) => e.type === "m.room.history_visibility")?.content,
    { history_visibility: "shared" },
  );
  // Bot admin, whoever raised the alert moderator. Nothing below Tchap's
  // defaults at create time: it refuses the whole room.
  assert.deepEqual(room["power_level_content_override"], {
    users: { [BOT]: 100, [LANCEUR]: 50 },
  });
  // Every member may invite, opened once the room exists.
  assert.equal(f.powerLevels.length, 1);
  assert.equal(f.powerLevels[0]!["invite"], 0);
  assert.equal(f.powerLevels[0]!["state_default"], 50);
  assert.equal(f.salons.get("tmp-alerte-securite-metabase-280926"), "!alerte:hs");
});

test("lancer: everyone invited once, never the bot, before the bot writes", async () => {
  const f = fake({ referents: [REF1, LANCEUR, BOT, REF2, REF1] });
  await lancerAlerteSecu(f.deps);
  assert.deepEqual(
    f.seq.filter((s) => s.startsWith("invite")),
    [`invite ${LANCEUR} !alerte:hs`, `invite ${REF1} !alerte:hs`, `invite ${REF2} !alerte:hs`],
  );
  // Keys of an encrypted room follow those invited before a message is sent.
  const lastInvite = f.seq.findLastIndex((s) => s.startsWith("invite"));
  const firstPost = f.seq.findIndex((s) => s.startsWith("post"));
  assert.ok(lastInvite < firstPost);
});

test("lancer: the room opens on the prepared message, the announcement pings everyone", async () => {
  const f = fake();
  const res = await lancerAlerteSecu(f.deps);
  const [ouverture, annonce] = f.posts;
  assert.equal(ouverture?.roomId, "!alerte:hs");
  assert.equal(ouverture?.markdown, ficheAlerte(INFOS, LANCEUR, NOW));
  assert.deepEqual(ouverture?.mentions, {});
  assert.equal(annonce?.roomId, ANNONCE);
  assert.deepEqual(annonce?.mentions, { room: true });
  assert.match(annonce!.markdown, /^@room /);
  // Only the announcement may notify the whole room; the email stays manual.
  assert.doesNotMatch(res.message, AT_ROOM);
  assert.match(res.message, /alertes-securite@beta\.gouv\.fr/);
});

test("lancer: same component the same day joins the open room", async () => {
  const f = fake();
  f.salons.set("tmp-alerte-securite-metabase-280926", "!deja:hs");
  const res = await lancerAlerteSecu(f.deps);
  assert.equal(res.reaction, "🔁");
  assert.equal(f.created.length, 0);
  assert.equal(f.posts.length, 0);
  assert.deepEqual(f.seq, [`invite ${LANCEUR} !deja:hs`]);
});

test("lancer: a refused invitation is reported, the alert still goes out", async () => {
  const f = fake({}, { refuse: REF2 });
  const res = await lancerAlerteSecu(f.deps);
  assert.equal(res.reaction, "⚠️");
  assert.match(res.message, /invitation refusée pour `@ref2:hs`/);
  assert.match(res.message, /1 référent\(s\) invité\(s\)/);
  assert.equal(f.posts.length, 2);
});

test("lancer: a rate-limited invitation is retried", async () => {
  const f = fake({}, { rateLimitOnce: REF1 });
  const res = await lancerAlerteSecu(f.deps);
  assert.equal(res.reaction, "🚨");
  assert.ok(f.seq.includes(`invite ${REF1} !alerte:hs`));
});

test("lancer: a failed announcement is reported, never passed off as done", async () => {
  const f = fake({}, { announceFails: true });
  const res = await lancerAlerteSecu(f.deps);
  assert.equal(res.reaction, "⚠️");
  assert.match(res.message, /n'a pas pu être postée/);
  // The summary line must not claim the announcement went out.
  assert.doesNotMatch(res.message.split("\n")[0]!, /annonce/);
});

test("lancer: a bot too low to notify @room says so", async () => {
  const f = fake({}, { botLevelInAnnounce: 0 });
  const res = await lancerAlerteSecu(f.deps);
  assert.equal(res.reaction, "⚠️");
  assert.match(res.message, /pas le niveau pour notifier/);
});

test("lancer: missing configuration is reported, not fatal", async () => {
  const f = fake({ referents: [], annonceRoomId: undefined });
  const res = await lancerAlerteSecu(f.deps);
  assert.equal(res.reaction, "⚠️");
  assert.match(res.message, /ALERTE_SECU_REFERENTS/);
  assert.match(res.message, /ALERTE_SECU_ROOM/);
  assert.deepEqual(f.seq.filter((s) => s.startsWith("invite")), [`invite ${LANCEUR} !alerte:hs`]);
});

test("lancer: a refused room creation gives the server's reason", async () => {
  const f = fake({}, { createFails: true });
  const res = await lancerAlerteSecu(f.deps);
  assert.equal(res.reaction, "❌");
  assert.match(res.message, /création interdite/);
});
