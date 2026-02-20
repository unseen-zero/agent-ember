import { api } from './api-client'
import type { BoardTask } from '../types'

export const fetchTasks = (includeArchived = false) =>
  api<Record<string, BoardTask>>('GET', `/tasks${includeArchived ? '?includeArchived=true' : ''}`)

export const createTask = (data: { title: string; description: string; agentId: string }) =>
  api<BoardTask>('POST', '/tasks', data)

export const updateTask = (id: string, data: Partial<BoardTask>) =>
  api<BoardTask>('PUT', `/tasks/${id}`, data)

export const deleteTask = (id: string) =>
  api<BoardTask>('DELETE', `/tasks/${id}`)

export const archiveTask = (id: string) =>
  api<BoardTask>('PUT', `/tasks/${id}`, { status: 'archived' })

export const unarchiveTask = (id: string) =>
  api<BoardTask>('PUT', `/tasks/${id}`, { status: 'backlog' })
