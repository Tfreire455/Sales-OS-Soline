export function parseMoneyBR(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  let str = String(value).trim();
  if (!str) return 0;

  str = str.replace(/\s/g, '').replace(/^R\$/i, '');
  str = str.replace(/[^0-9,.-]/g, '');

  const hasComma = str.includes(',');
  const hasDot = str.includes('.');

  if (hasComma && hasDot) {
    if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (hasComma) {
    str = str.replace(',', '.');
  }

  const parsed = Number(str);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toFixedMoney(value) {
  return Number(parseMoneyBR(value).toFixed(2));
}

export function formatMoneyBR(value) {
  return toFixedMoney(value).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

export function seemsLegacyCentsBug(value) {
  const amount = parseMoneyBR(value);
  return Number.isFinite(amount) && amount >= 1000;
}
