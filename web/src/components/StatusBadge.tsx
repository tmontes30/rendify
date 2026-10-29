import { STATUS_LABELS, type Status } from '@rendiciones/shared';

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge ${status}`}>{STATUS_LABELS[status]}</span>;
}
