const MARKET_TIME_ZONE = "America/New_York";
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MINUTE = 30;

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
};

export function getProposalClosesAt(now = new Date()) {
  return getNextTradingDayOpen(now);
}

function getNextTradingDayOpen(now: Date) {
  const nowParts = getZonedDateParts(now, MARKET_TIME_ZONE);
  let candidate = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };

  if (!isTradingWeekday(nowParts.weekday) || hasMarketOpenPassed(nowParts)) {
    do {
      candidate = addDays(candidate, 1);
    } while (!isTradingWeekday(getWeekday(candidate, MARKET_TIME_ZONE)));
  }

  return zonedDateTimeToDate(
    {
      ...candidate,
      hour: MARKET_OPEN_HOUR,
      minute: MARKET_OPEN_MINUTE,
      second: 0,
    },
    MARKET_TIME_ZONE,
  );
}

function hasMarketOpenPassed(parts: ZonedDateParts) {
  return (
    parts.hour > MARKET_OPEN_HOUR ||
    (parts.hour === MARKET_OPEN_HOUR && parts.minute >= MARKET_OPEN_MINUTE)
  );
}

function isTradingWeekday(weekday: string) {
  return weekday !== "Sat" && weekday !== "Sun";
}

function getWeekday(
  date: { year: number; month: number; day: number },
  timeZone: string,
) {
  return getZonedDateParts(
    zonedDateTimeToDate(
      {
        ...date,
        hour: 12,
        minute: 0,
        second: 0,
      },
      timeZone,
    ),
    timeZone,
  ).weekday;
}

function addDays(
  date: { year: number; month: number; day: number },
  days: number,
) {
  const next = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function zonedDateTimeToDate(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  timeZone: string,
) {
  const utcTime = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const guess = new Date(utcTime);
  const offset = getTimeZoneOffsetMs(guess, timeZone);
  const candidate = new Date(utcTime - offset);
  const candidateOffset = getTimeZoneOffsetMs(candidate, timeZone);

  if (candidateOffset !== offset) {
    return new Date(utcTime - candidateOffset);
  }

  return candidate;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateParts(date, timeZone);
  const zonedTimeAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return zonedTimeAsUtc - date.getTime();
}

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekday = parts.weekday;

  if (!weekday) {
    throw new Error(`Could not read weekday for ${timeZone}.`);
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday,
  };
}
