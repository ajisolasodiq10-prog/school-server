const DAY = 24 * 60 * 60 * 1000;

// A "to" date typed as a plain date (midnight UTC) means the whole of that day.
export const endOfRange = (to) => (to.getTime() % DAY === 0 ? new Date(to.getTime() + DAY - 1) : to);
