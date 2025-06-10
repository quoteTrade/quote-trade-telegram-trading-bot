import numeral from 'numeral';

// ----------------------------------------------------------------------
function analyzeScientificNumber(num: any) {
  // Convert number to string to analyze
  const numString = num.toString();

  // Check if the number is in scientific notation
  const scientificNotationRegex = /^(-?\d+(?:\.\d+)?)[eE]([-+]?\d+)$/;
  const match = numString.match(scientificNotationRegex);

  if (match) {
    const [, significand, exponent] = match;

    // Calculate decimal places
    const decimalPlaces = Math.abs(parseInt(exponent, 10));

    return {
      isScientificNotation: true,
      originalNumber: num,
      significand: parseFloat(significand),
      exponent: parseInt(exponent, 10),
      decimalPlaces,
      normalizedNumber: num.toFixed(decimalPlaces)
    };
  }

  // If not in scientific notation
  const decimalPart = num.toString().split('.')[1];

  return {
    isScientificNotation: false,
    originalNumber: num,
    decimalPlaces: decimalPart ? decimalPart.length : 0
  };
}

export function fNumber(number: string) {
  return numeral(number).format();
}

export function cfThousandSeparator(number: any) {
  if (number % 1 === 0) {
    // If no decimal places, keep two decimal places
    return numeral(number).format("0,0.00");
  }

  const {isScientificNotation, decimalPlaces } = analyzeScientificNumber(number);
  // Check if the number is in scientific notation
  if (isScientificNotation) {
    return number.toFixed(decimalPlaces);
  }

  // Preserve exact decimal places
  return numeral(number).format("0,0.00[000000]");
}

export function fThousandSeparator(number: string) {
  return number ? numeral(number).format('0,0.00') : '';
}

export function fCurrency(number: any) {
  return number ? numeral(number).format('$0,0.00') : '';
}
