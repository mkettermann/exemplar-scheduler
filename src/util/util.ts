export class Util {

	static classof = (o: any): "string" | "number" | "nan" | "object" | "array" | "boolean" | "undefined" | "null" | "function" | "date" | "regexp" | "error" | "symbol" | "bigint" => {
		let nomeClasse = Object.prototype.toString.call(o).slice(8, -1).toLowerCase();
		if (nomeClasse == "number") {
			if (o.toString() == "NaN") {
				nomeClasse = "nan";
			}
		}
		return nomeClasse as any;
	};

	static limparOA = (oa: object | object[]) => {
		// Converte (OBJ / ARRAY) Limpar Nulos e Vazios
		let limparO_Execute = (o: any) => {
			for (let propName in o) {
				if (
					o[propName as keyof typeof o] === null ||
					o[propName as keyof typeof o] === undefined ||
					o[propName as keyof typeof o] === "" ||
					o[propName as keyof typeof o] === "undefined"
				) {
					delete o[propName as keyof typeof o];
				}
			}
			return o;
		}
		return Util.aCadaObjExecuta(oa, limparO_Execute);
	};

	static aCadaObjExecuta = (oa: object | object[], func: any): object | object[] => {
		// Verifica se ARRAY ou OBJETO e executa a função FUNC a cada objeto dentro de OA.
		if (Array.isArray(oa)) {
			for (let i = 0; i < oa.length; i++) {
				func(oa[i]);
			}
		} else {
			func(oa);
		}
		return oa;
	};

	static corVermelho = (texto: string, semFundo?: boolean) => {
		let colorido = `\x1b[31m${texto}\x1b[0m`;
		return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
	};

	static corVerde = (texto: string, semFundo?: boolean) => {
		let colorido = `\x1b[32m${texto}\x1b[0m`;
		return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
	};

	static corAmarelo = (texto: string, semFundo?: boolean) => {
		let colorido = `\x1b[33m${texto}\x1b[0m`;
		return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
	};

	static corAzul = (texto: string, semFundo?: boolean) => {
		let colorido = `\x1b[34m${texto}\x1b[0m`;
		return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
	};

	static corMagenta = (texto: string, semFundo?: boolean) => {
		let colorido = `\x1b[35m${texto}\x1b[0m`;
		return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
	};

	static corCiano = (texto: string, semFundo?: boolean) => {
		let colorido = `\x1b[36m${texto}\x1b[0m`;
		return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
	};

	static corBranco = (texto: string, semFundo?: boolean) => {
		let colorido = `\x1b[37m${texto}\x1b[0m`;
		return semFundo ? colorido : `${Util.fundoPreto(colorido)}`;
	};

	static corCinza = (texto: string, semFundo?: boolean) => {
		let colorido = `\x1b[90m${texto}\x1b[0m`;
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