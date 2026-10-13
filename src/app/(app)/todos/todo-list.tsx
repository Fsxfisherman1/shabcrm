"use client";

import clsx from "clsx";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { useActionForm } from "@/components/use-action-form";
import { addTodoAction, clearCompletedAction, deleteTodoAction, toggleTodoAction } from "@/actions/todos";
import { Button, Card, EmptyState, FormError, Input, Select } from "@/components/ui";

type Todo = {
  id: string;
  title: string;
  dueDate: string | null;
  done: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
};

export function TodoList({
  todos,
  workspaces,
  today,
}: {
  todos: Todo[];
  workspaces: { id: string; name: string }[];
  today: string;
}) {
  const [state, onSubmit, pending] = useActionForm(addTodoAction, { resetOnSuccess: true });
  const [optimistic, setOptimistic] = useOptimistic(todos, (list, { id, done }: { id: string; done: boolean }) =>
    list.map((t) => (t.id === id ? { ...t, done } : t)),
  );
  const [, startTransition] = useTransition();

  const open = optimistic.filter((t) => !t.done);
  const done = optimistic.filter((t) => t.done);

  function toggle(todo: Todo) {
    startTransition(async () => {
      setOptimistic({ id: todo.id, done: !todo.done });
      await toggleTodoAction(todo.id, !todo.done);
    });
  }

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
          <Input name="title" placeholder="Add a to-do…" aria-label="To-do" className="flex-1" required />
          <Input name="dueDate" type="date" aria-label="Due date" className="sm:w-40" />
          <Select name="workspaceId" aria-label="Link to account" className="sm:w-44" defaultValue="">
            <option value="">No account</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={pending}>
            Add
          </Button>
        </form>
        <div className="mt-2">
          <FormError message={state.error} />
        </div>
      </Card>

      {open.length === 0 ? (
        <EmptyState title="All caught up">Nothing left on your list.</EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {open.map((t) => (
              <TodoRow key={t.id} todo={t} today={today} onToggle={() => toggle(t)} />
            ))}
          </ul>
        </Card>
      )}

      {done.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-500">Done ({done.length})</h2>
            <Button variant="ghost" size="sm" onClick={() => startTransition(() => clearCompletedAction())}>
              Clear done
            </Button>
          </div>
          <Card>
            <ul className="divide-y divide-slate-100">
              {done.map((t) => (
                <TodoRow key={t.id} todo={t} today={today} onToggle={() => toggle(t)} />
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

function TodoRow({ todo, today, onToggle }: { todo: Todo; today: string; onToggle: () => void }) {
  const [, startTransition] = useTransition();
  const overdue = !todo.done && todo.dueDate && todo.dueDate < today;
  return (
    <li className="group flex items-center gap-3 px-4 py-3">
      <input
        type="checkbox"
        checked={todo.done}
        onChange={onToggle}
        aria-label={`Mark "${todo.title}" ${todo.done ? "not done" : "done"}`}
        className="h-4 w-4 rounded border-slate-300 accent-brand-600"
      />
      <div className="min-w-0 flex-1">
        <div className={clsx("text-sm", todo.done && "text-slate-400 line-through")}>{todo.title}</div>
        <div className="flex gap-3 text-xs text-slate-500">
          {todo.dueDate && (
            <span className={clsx(overdue && "font-medium text-red-600")}>
              {overdue ? "Overdue · " : "Due "}
              {new Date(`${todo.dueDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          )}
          {todo.workspaceId && todo.workspaceName && (
            <Link href={`/w/${todo.workspaceId}`} className="hover:text-brand-600">
              {todo.workspaceName}
            </Link>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => startTransition(() => deleteTodoAction(todo.id))}
        className="text-xs text-slate-400 opacity-0 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
        aria-label={`Delete "${todo.title}"`}
      >
        Delete
      </button>
    </li>
  );
}
