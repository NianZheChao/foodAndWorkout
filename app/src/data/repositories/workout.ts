import { db } from '../db'
import { toPlain } from '../plain'
import { newId } from './intake'
import type { WorkoutEntry } from '@/domain/types'

export async function listWorkoutByDate(date: string): Promise<WorkoutEntry[]> {
  return db.workout.where('date').equals(date).toArray()
}

export async function addWorkout(entry: Omit<WorkoutEntry, 'id'>): Promise<string> {
  const id = newId('wo')
  // 页面会把 `muscles` / `sets` 这类响应式数组直接传进来，落库前必须拍平（DataCloneError）
  await db.workout.put(toPlain({ ...entry, id }))
  return id
}

export async function updateWorkout(id: string, patch: Partial<WorkoutEntry>): Promise<void> {
  await db.workout.update(id, toPlain(patch))
}

export async function removeWorkout(id: string): Promise<void> {
  await db.workout.delete(id)
}

export async function listWorkoutInRange(start: string, end: string): Promise<WorkoutEntry[]> {
  return db.workout.where('date').between(start, end, true, true).toArray()
}
