import { HotelSerpApiConnector } from './hotel-serpapi.js'

/**
 * Registry de conectores. Mapeia `connector_key -> instancia` e `vertical ->
 * conector padrao`. O scanner pede o conector ao registry pelo vertical do
 * subject (ou pela connector_key do tenant), em vez de importar a fonte direto.
 *
 * Adicionar um vertical (ex.: combustivel) = registrar mais uma instancia aqui;
 * nada mais no scanner/motor/dashboard muda.
 */

const instances = [
  new HotelSerpApiConnector()
  // Fase 3: registrar `new FuelConnector()` aqui quando o download ao vivo do
  // arquivo ANP estiver plugado (o esqueleto ja existe em ./fuel-anp.js).
]

const byKey = new Map(instances.map((c) => [c.key, c]))

// Conector padrao por vertical (o primeiro registrado para aquele vertical).
const defaultByVertical = new Map()
for (const c of instances) {
  if (!defaultByVertical.has(c.vertical)) defaultByVertical.set(c.vertical, c.key)
}

/** Conector por chave estavel (ex.: 'hotel_serpapi'). */
export function getConnector (key) {
  return byKey.get(key) || null
}

/** Conector padrao de um vertical (ex.: 'hotel'). */
export function connectorForVertical (vertical) {
  return byKey.get(defaultByVertical.get(vertical)) || null
}

/** Lista todos os conectores registrados. */
export function listConnectors () {
  return [...byKey.values()]
}
