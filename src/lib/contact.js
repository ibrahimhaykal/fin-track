// Where users send suggestions, bugs and email formats the parser does not know yet.
export const DEVELOPER_EMAIL = 'ibrahimhaykal@gmail.com';

export const mailtoDeveloper = (subject) => `mailto:${DEVELOPER_EMAIL}?subject=${encodeURIComponent(subject)}`;
