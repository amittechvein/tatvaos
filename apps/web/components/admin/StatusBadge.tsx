const STYLES: Record<string, string> = {
  active: 'bg-green-50 text-green-700 ring-green-600/20',
  trial: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  pending: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  suspended: 'bg-red-50 text-red-700 ring-red-600/20',
  deleted: 'bg-gray-100 text-gray-600 ring-gray-500/20',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${
        STYLES[status] ?? STYLES.deleted
      }`}
    >
      {status}
    </span>
  );
}
