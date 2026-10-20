import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreatedRoom } from "../src/commands/created-rooms.js";

// The inactivity sweep through the real connector, with the homeserver faked.
// A room only counts as warned once the warning is in it: otherwise it is
// closed two weeks later with nobody ever told. The settings are read from the
// environment when config is first imported, so they are set before the
// dynamic import below, with a throwaway data directory for the record.

const DAY = 86_400_000;
const BOT = "@bot:hs";
// The homeserver refuses any post here (the bot lost the right to speak).
const REFUSE = "!refuse:hs";
const OUVERT = "!ouvert:hs";

const dataDir = mkdtempSync(join(tmpdir(), "betabot-inactivite-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));
process.env["DATA_DIR"] = dataDir;
process.env["INACTIVITE_DRY_RUN"] = "false";
process.env["INACTIVITE_JOURS"] = "60";
process.env["INACTIVITE_DELAI_JOURS"] = "14";
const { MatrixConnector } = await import("../src/connectors/matrix.js");

const registre = join(dataDir, "created-rooms.json");
// Two rooms created 200 days ago that nobody wrote in since.
writeFileSync(
  registre,
  JSON.stringify([
    { roomId: REFUSE, name: "pole-refuse", createdTs: Date.now() - 200 * DAY },
    { roomId: OUVERT, name: "pole-ouvert", createdTs: Date.now() - 200 * DAY },
  ]),
);

test("inactivite: a warning the homeserver refuses is not recorded, the one it takes is", async () => {
  const posted: Array<{ roomId: string; body: string }> = [];
  const client = {
    // Nobody but the bot ever wrote, in any room.
    async doRequest() {
      return { chunk: [] };
    },
    async sendEvent(roomId: string, _type: string, content: { body: string }) {
      if (roomId === REFUSE) {
        throw { errcode: "M_FORBIDDEN", error: "You don't have permission to post that to the room." };
      }
      posted.push({ roomId, body: content.body });
      return "$ev";
    },
  };
  const c = new MatrixConnector() as unknown as {
    client: typeof client;
    ownUserId: string;
    inactivityTick(): Promise<void>;
  };
  c.client = client;
  c.ownUserId = BOT;

  await c.inactivityTick();

  const rooms = JSON.parse(readFileSync(registre, "utf-8")) as CreatedRoom[];
  const avertiLe = (roomId: string) => rooms.find((r) => r.roomId === roomId)?.avertiLe;
  assert.equal(avertiLe(REFUSE), undefined, "refused warning recorded: the room would be closed unwarned");
  assert.equal(typeof avertiLe(OUVERT), "number");
  assert.deepEqual(posted.map((p) => p.roomId), [OUVERT]);
  assert.match(posted[0]!.body, /Aucun message dans ce salon/);
});
