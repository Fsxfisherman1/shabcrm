import type { Metadata } from "next";
import { db } from "@/db";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/lib/session";
import { listTodos } from "@/server/todos";
import { listWorkspacesForUser } from "@/server/workspaces";
import { TodoList } from "./todo-list";

export const metadata: Metadata = { title: "To-do" };

export default async function TodosPage() {
  const user = await getCurrentUser();
  const [todos, workspaces] = await Promise.all([listTodos(db, user.id), listWorkspacesForUser(db, user.id)]);
  const open = todos.filter((t) => !t.done).length;
  return (
    <div className="max-w-3xl">
      <PageHeader title="To-do" description={open === 1 ? "1 thing to do" : `${open} things to do`} />
      <TodoList
        todos={todos}
        workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
        today={new Date().toISOString().slice(0, 10)}
      />
    </div>
  );
}
