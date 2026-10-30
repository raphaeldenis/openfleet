const COMBINING_MARKS = /\p{M}/gu;

/** Returns the text with each accented letter as its base letter ("Mnémosyne" is "Mnemosyne"). */
export const withoutAccents = (text: string): string => text.normalize('NFD').replace(COMBINING_MARKS, '');
