const IST_TIMEZONE = "Asia/Kolkata";

function parseTimeToMinutes(timeString) {
  const [hours, minutes] = String(timeString || "00:00")
    .split(":")
    .map((value) => Number(value));
  return hours * 60 + minutes;
}

function getIstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function getMinutesSinceMidnight(date = new Date()) {
  const parts = getIstParts(date);
  return parts.hour * 60 + parts.minute;
}

function evaluateSchedulerWindow(date, schedule) {
  const minutes = getMinutesSinceMidnight(date);
  const currentDate = getIstParts(date).date;

  const feedStart = parseTimeToMinutes(schedule.feedStart);
  const strategyStart = parseTimeToMinutes(schedule.strategyStart);
  const strategyPause = parseTimeToMinutes(schedule.strategyPause);
  const squareOff = parseTimeToMinutes(schedule.squareOff || schedule.strategyPause);
  const feedStop = parseTimeToMinutes(schedule.feedStop);
  const strategyRunUntil = Math.min(strategyPause, squareOff);

  return {
    tradingDate: currentDate,
    feedShouldRun: minutes >= feedStart && minutes < feedStop,
    strategiesShouldRun: minutes >= strategyStart && minutes < strategyRunUntil,
    squareOffShouldRun: minutes >= squareOff && minutes < feedStop,
    archiveShouldRun: minutes >= feedStop,
  };
}

module.exports = {
  parseTimeToMinutes,
  getIstParts,
  getMinutesSinceMidnight,
  evaluateSchedulerWindow,
};
