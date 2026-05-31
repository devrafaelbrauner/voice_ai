import { getField, setField, clearField } from './db';

export const getRecordingName = (fileName: string) =>
  getField(fileName, 'customName');

export const setRecordingName = (fileName: string, name: string) =>
  setField(fileName, 'customName', name);

export const deleteRecordingName = (fileName: string) =>
  clearField(fileName, 'customName');

export function formatDefaultName(createdAt: string): string {
  const d = new Date(createdAt);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `Gravação ${day}/${month} ${hours}:${mins}`;
}
