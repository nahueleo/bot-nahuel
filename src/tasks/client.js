import { google } from 'googleapis';
import { getAuthClient } from '../auth/google.js';

async function getTasksClient(accountName) {
  const auth = await getAuthClient(accountName);
  if (!auth) throw new Error(`Cuenta "${accountName}" no conectada. Autenticá primero en /auth/google?account=${accountName}`);
  return google.tasks({ version: 'v1', auth });
}

/**
 * Lista todas las listas de tareas del usuario.
 */
export async function listTaskLists(accountName) {
  const tasks = await getTasksClient(accountName);

  const { data } = await tasks.tasklists.list({ maxResults: 20 });
  return (data.items || []).map((list) => ({
    id:      list.id,
    title:   list.title,
    updated: list.updated,
  }));
}

/**
 * Obtiene tareas de una lista. Si taskListId es '@default', usa la lista principal.
 */
export async function getTasks(accountName, taskListId = '@default', showCompleted = false) {
  const tasks = await getTasksClient(accountName);

  const { data } = await tasks.tasks.list({
    tasklist:      taskListId,
    showCompleted,
    showHidden:    false,
    maxResults:    50,
  });

  return (data.items || []).map((task) => ({
    id:        task.id,
    title:     task.title,
    notes:     task.notes || '',
    status:    task.status,
    due:       task.due || null,
    completed: task.completed || null,
    parent:    task.parent || null,
    position:  task.position,
  }));
}

/**
 * Crea una nueva tarea en una lista.
 */
export async function createTask(accountName, taskListId = '@default', taskData) {
  const tasks = await getTasksClient(accountName);

  const resource = {
    title:  taskData.title,
    notes:  taskData.notes || undefined,
    status: 'needsAction',
  };

  // due debe ser RFC 3339 con hora en medianoche UTC: "2025-04-25T00:00:00.000Z"
  if (taskData.due) {
    const d = new Date(taskData.due);
    d.setUTCHours(0, 0, 0, 0);
    resource.due = d.toISOString();
  }

  const { data } = await tasks.tasks.insert({
    tasklist: taskListId,
    resource,
  });

  return {
    id:     data.id,
    title:  data.title,
    notes:  data.notes || '',
    status: data.status,
    due:    data.due || null,
  };
}

/**
 * Actualiza una tarea existente (título, notas, fecha).
 */
export async function updateTask(accountName, taskListId = '@default', taskId, taskData) {
  const tasks = await getTasksClient(accountName);

  // Obtener tarea actual para hacer merge
  const { data: current } = await tasks.tasks.get({
    tasklist: taskListId,
    task:     taskId,
  });

  const resource = {
    ...current,
    title: taskData.title ?? current.title,
    notes: taskData.notes ?? current.notes,
  };

  if (taskData.due) {
    const d = new Date(taskData.due);
    d.setUTCHours(0, 0, 0, 0);
    resource.due = d.toISOString();
  }

  const { data } = await tasks.tasks.update({
    tasklist: taskListId,
    task:     taskId,
    resource,
  });

  return {
    id:     data.id,
    title:  data.title,
    notes:  data.notes || '',
    status: data.status,
    due:    data.due || null,
  };
}

/**
 * Marca una tarea como completada.
 */
export async function completeTask(accountName, taskListId = '@default', taskId) {
  const tasks = await getTasksClient(accountName);

  const { data: current } = await tasks.tasks.get({
    tasklist: taskListId,
    task:     taskId,
  });

  const { data } = await tasks.tasks.update({
    tasklist: taskListId,
    task:     taskId,
    resource: { ...current, status: 'completed', completed: new Date().toISOString() },
  });

  return { id: data.id, title: data.title, status: data.status, completed: data.completed };
}

/**
 * Elimina una tarea.
 */
export async function deleteTask(accountName, taskListId = '@default', taskId) {
  const tasks = await getTasksClient(accountName);

  await tasks.tasks.delete({
    tasklist: taskListId,
    task:     taskId,
  });

  return { deleted: true, taskId };
}
