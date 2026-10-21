import type { MatrixClient } from "matrix-bot-sdk";
import { unknownFlags } from "./flags.js";
import { grantModeratorRights, roomLink, roomName } from "./rooms.js";

// `/alerte` — procédure SSI « Composant vulnérable ».
//
// When a critical vulnerability (CVSS > 9) may hit a component shared by
// several products, anyone in the community can raise the alert, from
// anywhere the bot is. The bot asks its questions in a DM — typed in a room,
// the command opens one — then shows the message that will open the alert
// room. Once confirmed, it creates the room, invites the référents (techs and
// SSI), posts that message, and announces the room with @room in
// ~Domaine-secu. The email to alertes-securite@ stays manual; the last DM
// reminds it.
//
// Nothing here talks to Matrix directly: the conversation is plain state, and
// the Matrix calls of the launch are injected (AlerteDeps), so all of it runs
// against fakes in the tests.

const VERBE = "/alerte";

// "@room" as text, for the messages that talk about the room mention without
// performing one. The legacy push rule matches the bare word anywhere in a
// message body, so a help showing a plain "@room" would ping the whole room it
// is displayed in; the zero-width space keeps it a word nobody matches.
const AT_ROOM_TEXTE = "@\u200Broom";

export function isAlerteCommand(text: string): boolean {
  return (text.trim().split(/\s+/)[0] ?? "").toLowerCase() === VERBE;
}

export type AlerteCommande =
  | { kind: "aide" }
  | { kind: "annuler" }
  | { kind: "erreur"; message: string }
  // Start the questions — with the component when it came with the command.
  | { kind: "demarrer"; composant?: string };

// `/alerte [composant]`, `/alerte help`, `/alerte annuler`.
export function parseAlerte(text: string): AlerteCommande {
  const args = text.trim().slice(VERBE.length).trim();
  if (/^(help|aide)$/i.test(args)) return { kind: "aide" };
  if (/^(annuler|stop)$/i.test(args)) return { kind: "annuler" };
  // No option exists: an unknown one is refused rather than swallowed into
  // the component name (see flags.ts).
  const inconnus = unknownFlags(args, new Set());
  if (inconnus.length > 0) {
    return {
      kind: "erreur",
      message: `❌ \`/alerte\` ne prend pas d'option (${inconnus.map((f) => `\`--${f}\``).join(", ")}) : tape \`/alerte\` et réponds à mes questions. Aide : \`/alerte help\`.`,
    };
  }
  if (!args) return { kind: "demarrer" };
  const lu = lireComposant(args);
  if (!lu.ok) return { kind: "erreur", message: `❌ ${lu.erreur}` };
  return { kind: "demarrer", composant: lu.valeur };
}

// Room-name form of a component: lowercase ASCII words joined by "-".
export function slugComposant(composant: string): string {
  return composant
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// Day, month and year of `now` in Paris: an alert raised at 00:30 belongs to
// that day, not to the UTC one.
function jourParis(now: Date): { jj: string; mm: string; aaaa: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { jj: p["day"] ?? "", mm: p["month"] ?? "", aaaa: p["year"] ?? "" };
}

// The procedure's naming: tmp-alerte-securite-<composant>-JJMMAA.
export const PREFIXE_SALON_ALERTE = "tmp-alerte-securite-";

export function nomSalonAlerte(composant: string, now: Date): string {
  const { jj, mm, aaaa } = jourParis(now);
  return `${PREFIXE_SALON_ALERTE}${slugComposant(composant)}-${jj}${mm}${aaaa.slice(-2)}`;
}

// A matrix.to link to a user, rendered as a pill by Tchap/Element.
function userLink(userId: string): string {
  return `[${userId}](https://matrix.to/#/${userId})`;
}

// ─── Questions ───────────────────────────────────────────────────────────────

export type OuiNon = "oui" | "non" | "inconnu";

// What the questions collect: the procedure's minimum description.
export interface InfosAlerte {
  composant: string;
  resume: string;
  cvss?: string;
  cve?: string;
  exploitee: OuiNon;
  patch: OuiNon;
  versions?: string;
  lien?: string;
  remediation?: string;
}

type Lecture = { ok: true; valeur?: string } | { ok: false; erreur: string };

// Answers that pass an optional question.
const PASSER =
  /^(-|\?|non|aucune?s?|inconnue?s?|n\/a|na|passer|je ne sais pas|jsp)$/i;

function optionnel(lire: (r: string) => Lecture): (r: string) => Lecture {
  return (r) => (PASSER.test(r) ? { ok: true } : lire(r));
}

function lireComposant(r: string): Lecture {
  const c = r.replace(/^["']|["']$/g, "").trim();
  return slugComposant(c)
    ? { ok: true, valeur: c }
    : { ok: false, erreur: "Donne le nom du composant, par exemple `metabase`." };
}

function lireResume(r: string): Lecture {
  return PASSER.test(r) || r.length < 5
    ? {
        ok: false,
        erreur: "Décris-la en une phrase au moins : c'est ce que liront les référents.",
      }
    : { ok: true, valeur: r };
}

function lireTexte(r: string): Lecture {
  return { ok: true, valeur: r };
}

function lireCvss(r: string): Lecture {
  const n = Number(r.replace(",", "."));
  return /^\d{1,2}([.,]\d)?$/.test(r) && n <= 10
    ? { ok: true, valeur: n.toFixed(1) }
    : { ok: false, erreur: "Un score CVSS va de 0 à 10, par exemple `9.8`." };
}

function lireCve(r: string): Lecture {
  const ids = r.toUpperCase().match(/CVE-\d{4}-\d{4,}/g);
  return ids
    ? { ok: true, valeur: [...new Set(ids)].join(", ") }
    : { ok: false, erreur: "Un identifiant CVE ressemble à `CVE-2026-1234`." };
}

function lireOuiNon(r: string): Lecture {
  if (/^(oui|o|yes|y)$/i.test(r)) return { ok: true, valeur: "oui" };
  if (/^(non|n|no)$/i.test(r)) return { ok: true, valeur: "non" };
  if (/^(inconnu|\?|-|je ne sais pas|jsp)$/i.test(r)) {
    return { ok: true, valeur: "inconnu" };
  }
  return { ok: false, erreur: "Réponds `oui`, `non` ou `inconnu`." };
}

function lireLien(r: string): Lecture {
  const url = r.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,;)\]>]+$/, "");
  return url
    ? { ok: true, valeur: url }
    : { ok: false, erreur: "Il me faut un lien qui commence par `https://`." };
}

interface Question {
  cle: keyof InfosAlerte;
  texte: string;
  lire: (reponse: string) => Lecture;
}

const QUESTIONS: readonly Question[] = [
  {
    cle: "composant",
    texte: "Quel **composant** est vulnérable ? (ex. `metabase`, `log4j`)",
    lire: lireComposant,
  },
  {
    cle: "resume",
    texte: "**Décris la vulnérabilité** en quelques phrases : ce qui est touché, ce qu'un attaquant peut faire.",
    lire: lireResume,
  },
  {
    cle: "cvss",
    texte: "**Score CVSS** ? (ex. `9.8`, ou `-` si inconnu)",
    lire: optionnel(lireCvss),
  },
  {
    cle: "cve",
    texte: "**Identifiant CVE** ? (ex. `CVE-2026-1234`, ou `-` s'il n'y en a pas)",
    lire: optionnel(lireCve),
  },
  {
    cle: "exploitee",
    texte: "Est-elle **exploitée dans la nature** ? `oui` / `non` / `inconnu`",
    lire: lireOuiNon,
  },
  {
    cle: "patch",
    texte: "Un **patch** est-il disponible ? `oui` / `non` / `inconnu`",
    lire: lireOuiNon,
  },
  {
    cle: "versions",
    texte: "Quelles **versions** sont vulnérables ? (ex. `< 1.50.3`, ou `-` si inconnu)",
    lire: optionnel(lireTexte),
  },
  {
    cle: "lien",
    texte: "**Lien vers le bulletin de l'éditeur** (à défaut, un article) ? (`-` si aucun)",
    lire: optionnel(lireLien),
  },
  {
    cle: "remediation",
    texte: "**Remédiation ou contournement** connus à date ? (`-` si aucun)",
    lire: optionnel(lireTexte),
  },
];

function question(etape: number): string {
  return `**Question ${etape + 1}/${QUESTIONS.length}** — ${QUESTIONS[etape]!.texte}`;
}

// What the connector does after an answer.
export type Suite =
  // Send this message: the next question, or the same one again.
  | { kind: "question"; message: string }
  // The component just got its answer: check that no alert is already open
  // for it today before sending `message`, the next question.
  | { kind: "composant"; composant: string; message: string }
  // Every answer is in: show the recap and wait for oui / non.
  | { kind: "recap"; infos: InfosAlerte }
  // Confirmed: launch the alert.
  | { kind: "lancer"; infos: InfosAlerte }
  | { kind: "annulee" };

interface Conversation {
  dmRoomId: string;
  // Index of the question awaiting an answer; QUESTIONS.length = confirmation.
  etape: number;
  infos: Partial<Record<keyof InfosAlerte, string>>;
  // Last activity: the conversation expires `ttlMs` after it.
  depuis: number;
}

// The alerts being prepared, one per user, keyed by Matrix user id. In memory
// only: after a restart the user simply runs /alerte again.
export class ConversationsAlerte {
  private readonly map = new Map<string, Conversation>();

  constructor(private readonly ttlMs = 2 * 60 * 60 * 1000) {}

  // Start — or restart — the questions in `dmRoomId`. Returns the first
  // message to send.
  demarrer(
    userId: string,
    dmRoomId: string,
    now: number,
    composant?: string,
  ): string {
    const etape = composant ? 1 : 0;
    this.map.set(userId, {
      dmRoomId,
      etape,
      infos: composant ? { composant } : {},
      depuis: now,
    });
    return [
      `🚨 **Alerte sécurité** — je prépare le salon avec toi : ${QUESTIONS.length - etape} questions, puis je te montre le message avant de lancer quoi que ce soit.`,
      "Tape `annuler` à tout moment pour tout arrêter, `-` pour passer une question facultative.",
      "",
      question(etape),
    ].join("\n");
  }

  // Is this user answering questions in this DM (and not expired)?
  enCours(userId: string, dmRoomId: string, now: number): boolean {
    const c = this.map.get(userId);
    if (!c) return false;
    if (now - c.depuis > this.ttlMs) {
      this.map.delete(userId);
      return false;
    }
    return c.dmRoomId === dmRoomId;
  }

  // Drop the conversation. True when there was one.
  annuler(userId: string): boolean {
    return this.map.delete(userId);
  }

  // Take an answer. The caller has checked `enCours` first.
  repondre(userId: string, reponse: string, now: number): Suite {
    const c = this.map.get(userId);
    if (!c) return { kind: "annulee" };
    const r = reponse.trim();
    if (/^(annuler|stop)$/i.test(r)) {
      this.map.delete(userId);
      return { kind: "annulee" };
    }
    c.depuis = now;
    if (c.etape >= QUESTIONS.length) {
      if (/^(oui|o|yes|y)$/i.test(r)) {
        this.map.delete(userId);
        return { kind: "lancer", infos: c.infos as unknown as InfosAlerte };
      }
      if (/^(non|n|no)$/i.test(r)) {
        this.map.delete(userId);
        return { kind: "annulee" };
      }
      return {
        kind: "question",
        message: "Réponds **oui** pour lancer l'alerte, ou **non** pour l'annuler.",
      };
    }
    const q = QUESTIONS[c.etape]!;
    const lu = q.lire(r);
    if (!lu.ok) {
      return { kind: "question", message: `${lu.erreur}\n\n${question(c.etape)}` };
    }
    if (lu.valeur !== undefined) c.infos[q.cle] = lu.valeur;
    c.etape++;
    if (c.etape >= QUESTIONS.length) {
      return { kind: "recap", infos: c.infos as unknown as InfosAlerte };
    }
    if (q.cle === "composant") {
      return {
        kind: "composant",
        composant: c.infos.composant!,
        message: question(c.etape),
      };
    }
    return { kind: "question", message: question(c.etape) };
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

export function buildAlerteHelp(handle: string): string {
  return [
    "# `/alerte` — alerte sécurité « composant vulnérable »",
    "",
    "À lancer quand une vulnérabilité **critique** (CVSS > 9) peut toucher un composant partagé par plusieurs produits. Il faut un faisceau d'indices suffisant : un article de presse ne suffit pas. Dans le doute, demande d'abord l'avis de ~Domaine-secu.",
    "",
    "| Commande | Effet |",
    "|---|---|",
    "| `/alerte` (en MP) | Je te pose les questions de la procédure, te montre le message final, puis ouvre le salon d'alerte quand tu confirmes |",
    `| \`${handle} /alerte\` (en salon) | Pareil, mais je t'écris en MP pour les questions |`,
    "| `/alerte <composant>` | Pareil, en sautant la question du composant |",
    "| `/alerte annuler` | Abandonne l'alerte en préparation |",
    "",
    `- À la fin, j'ouvre \`tmp-alerte-securite-<composant>-JJMMAA\` (privé, chiffré, historique partagé avec les nouveaux membres, tout membre peut inviter), j'y invite les référents techs et SSI, j'y poste ta description, et j'annonce le salon à tout ~Domaine-secu (${AT_ROOM_TEXTE}).`,
    "- Rien n'est créé avant ton **oui** final.",
    "- Même composant le même jour : pas de second salon, je t'invite dans celui qui existe.",
    "- L'email à `alertes-securite@beta.gouv.fr` reste à envoyer toi-même : je te le rappelle à la fin.",
  ].join("\n");
}

function ouiNon(v: OuiNon): string {
  return v === "oui" ? "**Oui**" : v === "non" ? "Non" : "Inconnu";
}

// The first message of the alert room: why everyone is here, what the
// vulnerability is, and what is expected of whom.
export function ficheAlerte(
  infos: InfosAlerte,
  lanceur: string,
  now: Date,
): string {
  const { jj, mm, aaaa } = jourParis(now);
  const ou = (v?: string) => v ?? "_non renseigné_";
  return [
    `# 🚨 Alerte sécurité — ${infos.composant}`,
    "",
    "## Pourquoi tu es invité·e",
    `Une vulnérabilité **critique** touche **${infos.composant}**, un composant qui peut être utilisé par plusieurs produits beta.gouv.fr. Tu es invité·e en tant que référent·e tech ou SSI : ce salon coordonne la réponse (procédure SSI « Composant vulnérable »).`,
    "",
    "## La vulnérabilité",
    infos.resume,
    "",
    `- **Score CVSS** : ${ou(infos.cvss)}`,
    `- **CVE** : ${ou(infos.cve)}`,
    `- **Exploitée dans la nature** : ${ouiNon(infos.exploitee)}`,
    `- **Patch disponible** : ${ouiNon(infos.patch)}`,
    `- **Versions vulnérables** : ${ou(infos.versions)}`,
    `- **Bulletin éditeur** : ${ou(infos.lien)}`,
    "",
    "## Remédiation connue à date",
    infos.remediation ?? "_Aucune pour l'instant._",
    "",
    "## Ce qu'on attend de vous",
    "- **Référents techs** : relayez l'alerte à vos équipes, invitez qui doit l'être (tout membre peut inviter), suivez l'application des correctifs, et accusez réception ici.",
    "- **Référents SSI** : requalifiez la vulnérabilité si besoin, partagez la documentation utile (audit, correctifs, détection de compromission) et animez les échanges.",
    "",
    `Alerte lancée par ${userLink(lanceur)} le ${jj}/${mm}/${aaaa}. Elle est close quand tous les acteurs impactés ont accusé réception et savent quoi corriger, et comment. L'historique de ce salon est partagé avec les nouveaux membres.`,
  ].join("\n");
}

// Posted in ~Domaine-secu with a real room mention: the one message meant to
// notify everybody.
export function annonceAlerte(
  infos: InfosAlerte,
  lanceur: string,
  salonId: string,
  nom: string,
): string {
  const details = [
    infos.cvss ? `CVSS ${infos.cvss}` : "",
    infos.cve ?? "",
    infos.exploitee === "oui" ? "exploitée dans la nature" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return [
    `@room 🚨 **Alerte sécurité** : vulnérabilité sur **${infos.composant}**${details ? ` (${details})` : ""}, signalée par ${userLink(lanceur)}.`,
    "",
    `Salon dédié : ${roomLink(salonId, nom)}. Il est sur invitation : les référents techs y sont, demande-leur de t'y ajouter si tes équipes sont concernées.`,
  ].join("\n");
}

// Shown before anything is created: the exact first message of the room, and
// what the launch will do.
export function recapAlerte(p: {
  infos: InfosAlerte;
  lanceur: string;
  now: Date;
  nbReferents: number;
  annonce: string | null;
}): string {
  const cvss = p.infos.cvss === undefined ? undefined : Number(p.infos.cvss);
  return [
    "📋 **Voici le message qui ouvrira le salon d'alerte :**",
    "",
    "---",
    "",
    ficheAlerte(p.infos, p.lanceur, p.now),
    "",
    "---",
    "",
    `- Salon : \`${nomSalonAlerte(p.infos.composant, p.now)}\` (privé, chiffré, historique partagé, tout membre peut inviter)`,
    `- Invités : toi + ${p.nbReferents} référent(s)${p.nbReferents === 0 ? " — ⚠️ aucun configuré (`ALERTE_SECU_REFERENTS`)" : ""}`,
    `- Annonce ${AT_ROOM_TEXTE} dans : ${p.annonce ?? "⚠️ aucun salon configuré (`ALERTE_SECU_ROOM`)"}`,
    ...(cvss !== undefined && cvss < 9
      ? [
          "",
          `⚠️ CVSS ${p.infos.cvss} : la procédure vise les vulnérabilités critiques (CVSS > 9). Dans le doute, demande d'abord l'avis de ~Domaine-secu.`,
        ]
      : []),
    "",
    "Réponds **oui** pour lancer l'alerte, **non** pour l'annuler.",
  ].join("\n");
}

// ─── Launch ──────────────────────────────────────────────────────────────────

export type AlerteClient = Pick<
  MatrixClient,
  "createRoom" | "inviteUser" | "getRoomStateEvent" | "sendStateEvent"
>;

// Who a posted message notifies (m.mentions).
export interface Mentions {
  room?: boolean;
  user_ids?: string[];
}

// The rooms the bot opened (data/created-rooms.json).
export interface SalonsCrees {
  find: (name: string) => string | undefined;
  add: (roomId: string, name: string) => void;
}

export interface AlerteDeps {
  client: AlerteClient;
  // Post a message. Must throw when it could not be delivered, so a missing
  // announcement is reported instead of passing for a success.
  post: (roomId: string, markdown: string, mentions: Mentions) => Promise<void>;
  salons: SalonsCrees;
  botUserId: string;
  lanceur: string;
  infos: InfosAlerte;
  now: Date;
  // ALERTE_SECU_REFERENTS and ALERTE_SECU_ROOM.
  referents: readonly string[];
  annonceRoomId?: string;
}

export interface AlerteResult {
  reaction: string;
  message: string;
  // Short note for the command history.
  detail: string;
}

// The référents to invite, once each: neither whoever raised the alert (they
// are invited as such) nor the bot.
export function referentsAInviter(
  referents: readonly string[],
  lanceur: string,
  botUserId: string,
): string[] {
  return [...new Set(referents)].filter(
    (u) => u && u !== lanceur && u !== botUserId,
  );
}

// A link to the announcement room, labelled with its name when readable.
export async function libelleAnnonce(
  client: Pick<MatrixClient, "getRoomStateEvent">,
  roomId: string | undefined,
): Promise<string | null> {
  if (!roomId) return null;
  return roomLink(roomId, (await roomName(client, roomId)) || "le salon d'annonce");
}

// The alert room opened today for this component, if any.
export function alerteOuverte(
  salons: SalonsCrees,
  composant: string,
  now: Date,
): string | undefined {
  return salons.find(nomSalonAlerte(composant, now));
}

// Same component, same day: the alert is already running. Bring the newcomer
// in rather than opening a second room and notifying the whole community
// twice.
export async function rejoindreAlerte(
  d: Pick<AlerteDeps, "client" | "lanceur" | "botUserId">,
  existant: string,
  composant: string,
  now: Date,
): Promise<AlerteResult> {
  if (d.lanceur !== d.botUserId) {
    await d.client.inviteUser(d.lanceur, existant).catch(() => {
      // already a member, or already invited
    });
  }
  return {
    reaction: "🔁",
    message: `🔁 Une alerte **${composant}** est déjà ouverte aujourd'hui : ${roomLink(existant, nomSalonAlerte(composant, now))}. Je t'y invite : ajoute ce que tu sais directement dans le salon.`,
    detail: `alerte déjà ouverte ${existant}`,
  };
}

// Whether the bot's own level lets its @room notify anyone
// (`notifications.room`, 50 by default). Below it the message is still
// posted, but nobody is pinged and nothing says so.
async function peutNotifierSalon(
  client: AlerteClient,
  roomId: string,
  botUserId: string,
): Promise<boolean> {
  try {
    const pl = (await client.getRoomStateEvent(
      roomId,
      "m.room.power_levels",
      "",
    )) as {
      users?: Record<string, number>;
      users_default?: number;
      notifications?: { room?: number };
    };
    const niveau = pl?.users?.[botUserId] ?? pl?.users_default ?? 0;
    return niveau >= (pl?.notifications?.room ?? 50);
  } catch {
    return false;
  }
}

// What went wrong, in words. A Matrix error carries its reason in `error`
// and `errcode`; its `message` is empty.
function raison(err: unknown): string {
  const e = err as { error?: string; errcode?: string; message?: string };
  return String(e?.error || e?.errcode || e?.message || err).slice(0, 300);
}

// Invite one user, waiting out the homeserver's rate limit when it answers
// M_LIMIT_EXCEEDED: Synapse lets through a burst of about ten invitations per
// room, fewer than the référents of a real alert.
async function inviter(
  client: AlerteClient,
  userId: string,
  roomId: string,
): Promise<void> {
  for (let essai = 1; ; essai++) {
    try {
      await client.inviteUser(userId, roomId);
      return;
    } catch (err) {
      const e = err as { errcode?: string; retryAfterMs?: number };
      if (e?.errcode !== "M_LIMIT_EXCEEDED" || essai >= 4) throw err;
      const attente = Math.min(e.retryAfterMs ?? 2000, 10_000);
      await new Promise((r) => setTimeout(r, attente));
    }
  }
}

export async function lancerAlerteSecu(d: AlerteDeps): Promise<AlerteResult> {
  const { composant } = d.infos;
  const nom = nomSalonAlerte(composant, d.now);
  // Checked again at launch: someone else may have raised the same alert
  // while this one was being prepared.
  const existant = alerteOuverte(d.salons, composant, d.now);
  if (existant) return rejoindreAlerte(d, existant, composant, d.now);

  const referents = referentsAInviter(d.referents, d.lanceur, d.botUserId);
  const invites = [
    ...(d.lanceur !== d.botUserId ? [d.lanceur] : []),
    ...referents,
  ];
  const annonce = await libelleAnnonce(d.client, d.annonceRoomId);

  const { jj, mm, aaaa } = jourParis(d.now);
  let roomId: string;
  try {
    roomId = await d.client.createRoom({
      name: nom,
      topic: `Alerte sécurité — ${composant} — lancée par ${d.lanceur} le ${jj}/${mm}/${aaaa}`,
      preset: "private_chat",
      visibility: "private",
      // The bot stays admin (100) and whoever raised the alert becomes
      // moderator (50). Opening invitations to everyone comes right after:
      // Tchap answers « Invalid power levels content override » to an
      // `invite` below 50 at create time.
      power_level_content_override: {
        users: {
          [d.botUserId]: 100,
          ...(d.lanceur !== d.botUserId ? { [d.lanceur]: 50 } : {}),
        },
      },
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
        // Whoever arrives later sees what was said before. In an encrypted
        // room the keys follow every member invited before a message is sent,
        // which is why the invitations go out before the bot writes anything.
        {
          type: "m.room.history_visibility",
          state_key: "",
          content: { history_visibility: "shared" },
        },
      ],
    });
  } catch (err) {
    return {
      reaction: "❌",
      message: `❌ Impossible de créer le salon d'alerte : ${raison(err)}. Préviens ~Domaine-secu toi-même.`,
      detail: "alerte création échouée",
    };
  }
  d.salons.add(roomId, nom);

  const avertissements: string[] = [];
  // `invite: 0` lets every member invite: the procedure asks it for the
  // référents, who relay the alert to their teams.
  if (!(await grantModeratorRights(d.client, roomId, { invite: 0 }))) {
    avertissements.push(
      "les droits du salon n'ont pas pu être ajustés : seuls les modérateurs peuvent y inviter, et certains réglages restent réservés au bot.",
    );
  }
  // One invitation at a time, each on its own: a wrong ID in
  // ALERTE_SECU_REFERENTS must not sink the whole alert, only be reported.
  const refuses: string[] = [];
  for (const u of invites) {
    try {
      await inviter(d.client, u, roomId);
    } catch (err) {
      console.error(
        `[alerte] invitation de ${u} dans ${roomId} refusée:`,
        raison(err),
      );
      refuses.push(u);
    }
  }
  if (refuses.length > 0) {
    avertissements.push(
      `invitation refusée pour ${refuses.map((u) => `\`${u}\``).join(", ")}.`,
    );
  }
  if (referents.length === 0) {
    avertissements.push(
      "aucun référent invité : `ALERTE_SECU_REFERENTS` est vide.",
    );
  }

  try {
    // Nobody to ping here: the invitation already notified everyone.
    await d.post(roomId, ficheAlerte(d.infos, d.lanceur, d.now), {});
  } catch {
    avertissements.push(
      "le message d'ouverture n'a pas pu être posté dans le salon : colles-y ta description toi-même.",
    );
  }

  let annoncee = false;
  if (!d.annonceRoomId) {
    avertissements.push(
      "aucune annonce : `ALERTE_SECU_ROOM` n'est pas configuré. Préviens ~Domaine-secu toi-même, avec le lien du salon.",
    );
  } else {
    const notifie = await peutNotifierSalon(
      d.client,
      d.annonceRoomId,
      d.botUserId,
    );
    try {
      await d.post(
        d.annonceRoomId,
        annonceAlerte(d.infos, d.lanceur, roomId, nom),
        { room: true },
      );
      annoncee = true;
      if (!notifie) {
        avertissements.push(
          `l'annonce est postée dans ${annonce}, mais le bot n'y a pas le niveau pour notifier tout le salon : fais-y un ${AT_ROOM_TEXTE} toi-même.`,
        );
      }
    } catch {
      avertissements.push(
        `l'annonce n'a pas pu être postée dans ${annonce} (le bot en est-il membre ?). Préviens ce salon toi-même, avec le lien du salon d'alerte.`,
      );
    }
  }

  const invitesOk = referents.filter((u) => !refuses.includes(u)).length;
  const lignes = [
    `🚨 Alerte **${composant}** lancée : salon ${roomLink(roomId, nom)} ouvert, ${invitesOk} référent(s) invité(s)${
      annoncee ? `, annonce ${AT_ROOM_TEXTE} postée dans ${annonce}` : ""
    }.`,
    "📧 Dernière étape, à faire toi-même : envoie ces informations par email à `alertes-securite@beta.gouv.fr` (référents techs et personnes intéressées en copie cachée), avec le lien du salon.",
  ];
  if (avertissements.length > 0) {
    lignes.push("", ...avertissements.map((a) => `⚠️ ${a}`));
  }
  return {
    reaction: avertissements.length > 0 ? "⚠️" : "🚨",
    message: lignes.join("\n"),
    detail: `alerte ${roomId}${avertissements.length > 0 ? ` (${avertissements.length} avertissement(s))` : ""}`,
  };
}
