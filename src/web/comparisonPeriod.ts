/** Today is a calendar day on the bot host; rolling windows are exact durations. */
export function comparisonPeriodStart(period: string, now: number): number | null {
  if (period === 'all') return 0;
  if (period === '7' || period === '30') return now - Number(period) * 86400000;
  if (period === 'today') {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime();
  }
  return null;
}
