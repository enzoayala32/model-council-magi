/**
 * Tipos minimos de `qrcode`.
 *
 * El paquete no trae declaraciones propias. En vez de instalar `@types/qrcode`
 * (otra dependencia mas para dos funciones) o marcar el import como `any` (que
 * apagaria el chequeo justo donde mas importa), se declara aca lo que usamos
 * y nada mas: si la libreria cambiara la firma, typecheck lo veria.
 */
declare module "qrcode" {
  export type QRCodeToDataURLOptions = {
    /** Pixeles por modulo. */
    width?: number;
    /** Modulos de margen blanco alrededor. Estandar: 4. */
    margin?: number;
    /** Nivel de correccion de errores: L(7%) M(15%) Q(25%) H(30%). */
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  };
  /** Devuelve un data URL PNG listo para un <img src>. */
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
}
