import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { todos, workspaces } from "@/db/schema";

export async function listTodos(db: Db, userId: string) {
  return db
    .select({
      id: todos.id,
      title: todos.title,
      dueDate: todos.dueDate,
      done: todos.done,
      completedAt: todos.completedAt,
      workspaceId: todos.workspaceId,
      workspaceName: workspaces.name,
    })
    .from(todos)
    .leftJoin(workspaces, eq(workspaces.id, todos.workspaceId))
    .where(eq(todos.userId, userId))
    .orderBy(
      asc(todos.done),
      sql`${todos.dueDate} asc nulls last`,
      desc(todos.createdAt),
    );
}

export async function addTodo(
  db: Db,
  userId: string,
  input: { title: string; dueDate?: string | null; workspaceId?: string | null },
) {
  const title = input.title.trim();
  if (!title) return null;
  const [todo] = await db
    .insert(todos)
    .values({ userId, title, dueDate: input.dueDate || null, workspaceId: input.workspaceId || null })
    .returning();
  return todo;
}

export async function setTodoDone(db: Db, userId: string, todoId: string, done: boolean) {
  await db
    .update(todos)
    .set({ done, completedAt: done ? new Date() : null })
    .where(and(eq(todos.id, todoId), eq(todos.userId, userId)));
}

export async function deleteTodo(db: Db, userId: string, todoId: string) {
  await db.delete(todos).where(and(eq(todos.id, todoId), eq(todos.userId, userId)));
}

export async function clearCompletedTodos(db: Db, userId: string) {
  await db.delete(todos).where(and(eq(todos.userId, userId), eq(todos.done, true)));
}
