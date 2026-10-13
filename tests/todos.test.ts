import { beforeEach, describe, expect, it } from "vitest";
import { addTodo, clearCompletedTodos, listTodos, setTodoDone } from "@/server/todos";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

describe("to-do list", () => {
  beforeEach(resetDb);

  it("orders open items by due date and keeps users separate", async () => {
    const alex = await makeUser("Alex");
    const other = await makeUser("Other");
    const ws = await makeWorkspace(alex.id);
    await addTodo(db, alex.id, { title: "No date" });
    await addTodo(db, alex.id, { title: "Later", dueDate: "2026-12-01" });
    const soon = await addTodo(db, alex.id, { title: "Soon", dueDate: "2026-10-20", workspaceId: ws.id });
    await addTodo(db, other.id, { title: "Not mine" });

    let list = await listTodos(db, alex.id);
    expect(list.map((t) => t.title)).toEqual(["Soon", "Later", "No date"]);
    expect(list[0].workspaceName).toBe("Acme Plumbing");

    await setTodoDone(db, other.id, soon!.id, true); // someone else can't tick it
    await setTodoDone(db, alex.id, soon!.id, true);
    list = await listTodos(db, alex.id);
    expect(list.map((t) => t.title)).toEqual(["Later", "No date", "Soon"]);

    await clearCompletedTodos(db, alex.id);
    expect(await listTodos(db, alex.id)).toHaveLength(2);
    expect(await listTodos(db, other.id)).toHaveLength(1);
  });
});
