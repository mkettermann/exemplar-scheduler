/**
 * Helpers de uso geral, trazidos do repositório legado: cores de terminal e
 * manipulação de objeto. As advertências sobre mutação, profundidade e o uso
 * de `any` estão em `docs/10-utilitarios.md`.
 */
export class Util {

  static tipoDe = (valor: any): "string" | "number" | "nan" | "object" | "array" | "boolean" | "undefined" | "null" | "function" | "date" | "regexp" | "error" | "symbol" | "bigint" => {
    let nomeClasse = Object.prototype.toString.call(valor).slice(8, -1).toLowerCase();
    if (nomeClasse == "number") {
      if (valor.toString() == "NaN") {
        nomeClasse = "nan";
      }
    }
    return nomeClasse as any;
  };

  static limparOA = (objetoOuArray: object | object[]) => {
    const removerVazios = (objeto: any) => {
      for (const propriedade in objeto) {
        if (
          objeto[propriedade as keyof typeof objeto] === null ||
          objeto[propriedade as keyof typeof objeto] === undefined ||
          objeto[propriedade as keyof typeof objeto] === "" ||
          objeto[propriedade as keyof typeof objeto] === "undefined"
        ) {
          delete objeto[propriedade as keyof typeof objeto];
        }
      }
      return objeto;
    }
    return Util.aCadaObjExecuta(objetoOuArray, removerVazios);
  };

  static aCadaObjExecuta = (objetoOuArray: object | object[], funcao: any): object | object[] => {
    if (Array.isArray(objetoOuArray)) {
      for (let i = 0; i < objetoOuArray.length; i++) {
        funcao(objetoOuArray[i]);
      }
    } else {
      funcao(objetoOuArray);
    }
    return objetoOuArray;
  };

  static corVermelho = (texto: string, semFundo?: boolean) => {
    const colorido = `\x1b[31m${texto}\x1b[0m`;
    return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
  };

  static corVerde = (texto: string, semFundo?: boolean) => {
    const colorido = `\x1b[32m${texto}\x1b[0m`;
    return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
  };

  static corAmarelo = (texto: string, semFundo?: boolean) => {
    const colorido = `\x1b[33m${texto}\x1b[0m`;
    return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
  };

  static corAzul = (texto: string, semFundo?: boolean) => {
    const colorido = `\x1b[34m${texto}\x1b[0m`;
    return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
  };

  static corMagenta = (texto: string, semFundo?: boolean) => {
    const colorido = `\x1b[35m${texto}\x1b[0m`;
    return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
  };

  static corCiano = (texto: string, semFundo?: boolean) => {
    const colorido = `\x1b[36m${texto}\x1b[0m`;
    return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
  };

  static corBranco = (texto: string, semFundo?: boolean) => {
    const colorido = `\x1b[37m${texto}\x1b[0m`;
    return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
  };

  static corCinza = (texto: string, semFundo?: boolean) => {
    const colorido = `\x1b[90m${texto}\x1b[0m`;
    return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
  };

  static fundoPreto = (texto: string) => {
    return `\x1b[40m${texto}\x1b[0m`;
  };

  static fundoVermelho = (texto: string) => {
    return `\x1b[41m${texto}\x1b[0m`;
  };

  static fundoVerde = (texto: string) => {
    return `\x1b[42m${texto}\x1b[0m`;
  };

  static fundoAmarelo = (texto: string) => {
    return `\x1b[43m${texto}\x1b[0m`;
  };

  static fundoAzul = (texto: string) => {
    return `\x1b[44m${texto}\x1b[0m`;
  };

  static fundoMagenta = (texto: string) => {
    return `\x1b[45m${texto}\x1b[0m`;
  };

  static fundoCiano = (texto: string) => {
    return `\x1b[46m${texto}\x1b[0m`;
  };

  static fundoBranco = (texto: string) => {
    return `\x1b[47m${texto}\x1b[0m`;
  };

  static fundoCinza = (texto: string) => {
    return `\x1b[100m${texto}\x1b[0m`;
  };
}
