/** Where oracle setups and readings are read from (PFWA_API, default pfwa.fun). */
export const PFWA_API = (process.env.PFWA_API || 'https://pfwa.fun').replace(/\/$/, '');
