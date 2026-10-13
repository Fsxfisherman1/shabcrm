import { beforeEach, describe, expect, it } from "vitest";
import { createContact, getContact } from "@/server/contacts";
import {
  addStage,
  createDeal,
  deleteStage,
  getBoard,
  getWorkspaceStats,
  listPipelines,
  moveDeal,
  StageNotEmptyError,
  updateDeal,
} from "@/server/pipelines";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

async function setup() {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id);
  const [pipeline] = await listPipelines(db, ws.id);
  const board = (await getBoard(db, ws.id, pipeline.id))!;
  return { alex, ws, pipeline, stages: board.stages };
}

function column(board: NonNullable<Awaited<ReturnType<typeof getBoard>>>, stageId: string) {
  return board.cards.filter((c) => c.stageId === stageId).map((c) => c.title);
}

describe("pipelines", () => {
  beforeEach(resetDb);

  it("adds new deals to the top and moves them between stages in order", async () => {
    const { alex, ws, pipeline, stages } = await setup();
    const [s0, s1] = stages;
    const a = await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: s0.id, title: "A", valueCents: 100 }, alex.id);
    await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: s0.id, title: "B", valueCents: 200 }, alex.id);
    await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: s1.id, title: "C", valueCents: 300 }, alex.id);

    let board = (await getBoard(db, ws.id, pipeline.id))!;
    expect(column(board, s0.id)).toEqual(["B", "A"]);

    await moveDeal(db, ws.id, a.id, s1.id, 1, alex.id);
    board = (await getBoard(db, ws.id, pipeline.id))!;
    expect(column(board, s0.id)).toEqual(["B"]);
    expect(column(board, s1.id)).toEqual(["C", "A"]);

    await moveDeal(db, ws.id, a.id, s1.id, 0, alex.id);
    board = (await getBoard(db, ws.id, pipeline.id))!;
    expect(column(board, s1.id)).toEqual(["A", "C"]);
  });

  it("logs stage changes on the linked contact", async () => {
    const { alex, ws, pipeline, stages } = await setup();
    const c = await createContact(db, ws.id, { firstName: "Jane", email: "j@x.com" }, alex.id);
    const d = await createDeal(
      db,
      ws.id,
      { pipelineId: pipeline.id, stageId: stages[0].id, title: "Water heater", valueCents: 150000, contactId: c.id },
      alex.id,
    );
    await moveDeal(db, ws.id, d.id, stages[2].id, 0, alex.id);
    const detail = await getContact(db, ws.id, c.id);
    expect(detail!.timeline[0].body).toBe('"Water heater" moved to Appointment booked');
    expect(detail!.deals).toHaveLength(1);
  });

  it("won deals leave the board and count toward stats", async () => {
    const { alex, ws, pipeline, stages } = await setup();
    const d = await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: stages[0].id, title: "A", valueCents: 50000 }, alex.id);
    await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: stages[0].id, title: "B", valueCents: 25000 }, alex.id);
    await updateDeal(db, ws.id, d.id, { status: "won" });

    const board = (await getBoard(db, ws.id, pipeline.id))!;
    expect(board.cards.map((c) => c.title)).toEqual(["B"]);
    const stats = await getWorkspaceStats(db, ws.id);
    expect(stats).toMatchObject({ openDeals: 1, openValueCents: 25000, wonDeals30d: 1, wonValueCents30d: 50000 });
  });

  it("refuses to delete a stage that still has deals", async () => {
    const { alex, ws, pipeline, stages } = await setup();
    await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: stages[0].id, title: "A", valueCents: 0 }, alex.id);
    await expect(deleteStage(db, ws.id, stages[0].id)).rejects.toBeInstanceOf(StageNotEmptyError);
    const extra = await addStage(db, ws.id, pipeline.id, "Follow up later");
    expect(extra.position).toBe(stages.length);
    await deleteStage(db, ws.id, extra.id);
  });
});
