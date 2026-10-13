"use server";

import { refresh } from "next/cache";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/session";
import { getMembership } from "@/server/workspaces";
import { addTodo, clearCompletedTodos, deleteTodo, setTodoDone } from "@/server/todos";
import type { ActionState } from "./types";

export async function addTodoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await getCurrentUser();
  const title = String(form.get("title") ?? "").trim();
  if (!title) return { error: "Type a to-do first." };
  let workspaceId = String(form.get("workspaceId") ?? "") || null;
  if (workspaceId && !(await getMembership(db, user.id, workspaceId))) workspaceId = null;
  await addTodo(db, user.id, { title, dueDate: String(form.get("dueDate") ?? "") || null, workspaceId });
  refresh();
  return { ok: true };
}

export async function toggleTodoAction(todoId: string, done: boolean) {
  const user = await getCurrentUser();
  await setTodoDone(db, user.id, todoId, done);
  refresh();
}

export async function deleteTodoAction(todoId: string) {
  const user = await getCurrentUser();
  await deleteTodo(db, user.id, todoId);
  refresh();
}

export async function clearCompletedAction() {
  const user = await getCurrentUser();
  await clearCompletedTodos(db, user.id);
  refresh();
}
