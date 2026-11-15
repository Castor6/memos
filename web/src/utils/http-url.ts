const HTTP_URL = /^https?:\/\//i;

/** Whether text is an explicit http(s) address; only these become links automatically. */
export const isHttpUrl = (text: string) => HTTP_URL.test(text);
