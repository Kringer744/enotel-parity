/**
 * Registro de verticais da plataforma de paridade.
 *
 * Um vertical e CONFIG, nao codigo: declara qual conector usar, os canais
 * concorrentes padrao, os alvos padrao e o schema de parametros do alvo. Adicionar
 * um vertical (ex.: combustivel) = registrar mais uma entrada aqui + ter o conector
 * correspondente no registry de conectores (src/services/connectors/index.js).
 *
 * O motor de paridade, o dashboard, o scheduler, o orcamento e os alertas NAO
 * mudam por vertical -- so o conector e este registro.
 */

// Canais concorrentes padrao de hotel (as 6 OTAs). O canal 'direct' (ancora) e
// gerado por tenant (nome/patterns dependem da marca) via directChannelFor().
const HOTEL_COMPETITORS = [
  { slug: 'booking', name: 'Booking.com', kind: 'ota', sort_order: 10, color: '#eb6834', patterns: ['booking.com', 'booking'] },
  { slug: 'expedia', name: 'Expedia', kind: 'ota', sort_order: 20, color: '#1baf7a', patterns: ['expedia'] },
  { slug: 'hoteis_com', name: 'Hoteis.com', kind: 'ota', sort_order: 30, color: '#eda100', patterns: ['hoteis.com', 'hoteis', 'hotels.com'] },
  { slug: 'trip_com', name: 'Trip.com', kind: 'ota', sort_order: 40, color: '#e87ba4', patterns: ['trip.com', 'trip '] },
  { slug: 'maxmilhas', name: 'MaxMilhas (Max)', kind: 'ota', sort_order: 50, color: '#008300', patterns: ['maxmilhas', 'max milhas', 'maxmilhas.com'] },
  { slug: 'azul_viagens', name: 'Azul Viagens', kind: 'ota', sort_order: 60, color: '#4a3aa7', patterns: ['azul viagens', 'azulviagens', 'azul'] }
]

// Padroes genericos que identificam o site oficial em qualquer marca de hotel.
const DIRECT_GENERIC_PATTERNS = ['official site', 'site oficial', 'hotel website', 'book on the official']

// Tres horizontes cobrem last-minute, janela de reserva e planejamento.
const HOTEL_DEFAULT_TARGETS = [
  { label: 'Curto prazo (7 dias)', mode: 'rolling', horizon_days: 7, los: 2, adults: 2 },
  { label: 'Janela padrao (30 dias)', mode: 'rolling', horizon_days: 30, los: 2, adults: 2 },
  { label: 'Planejamento (60 dias)', mode: 'rolling', horizon_days: 60, los: 2, adults: 2 }
]

export const VERTICALS = {
  hotel: {
    key: 'hotel',
    label: 'Hotelaria',
    connectorKey: 'hotel_serpapi',
    active: true,
    // Rotulo do alvo/subject na UI (sem jargao tecnico).
    subjectLabel: 'propriedade',
    // Parametros de alvo (para validacao/UI): hotel usa datas + ocupacao.
    targetParams: ['check_in', 'check_out', 'adults', 'los', 'horizon_days'],
    competitors: HOTEL_COMPETITORS,
    defaultTargets: HOTEL_DEFAULT_TARGETS
  },

  // PRONTO para F3: registrado como config, mas active=false ate o loader ANP
  // (FuelConnector) ser validado contra arquivo real. O scanner/dashboard nao
  // habilitam um vertical inativo.
  fuel: {
    key: 'fuel',
    label: 'Combustivel',
    connectorKey: 'fuel_anp',
    active: false,
    subjectLabel: 'posto',
    targetParams: ['produto', 'praca'], // gasolina|etanol|diesel ; municipio/praca
    competitors: [],
    defaultTargets: []
  }
}

export function getVertical (key) {
  return VERTICALS[key] || null
}

export function listVerticals () {
  return Object.values(VERTICALS)
}

export function listActiveVerticals () {
  return Object.values(VERTICALS).filter((v) => v.active)
}

export function isVerticalActive (key) {
  return Boolean(VERTICALS[key]?.active)
}

/**
 * Canal 'direct' (ancora) de um tenant. O nome e os patterns dependem da marca:
 * a marca entra como padrao de casamento (ex.: 'enotel') junto dos genericos.
 * @param {string} brandName  nome de exibicao (ex.: 'Enotel')
 * @param {string[]} brandPatterns  termos que identificam o site oficial da marca
 */
export function directChannelFor (brandName, brandPatterns = []) {
  const extra = brandPatterns.map((p) => String(p).toLowerCase().trim()).filter(Boolean)
  return {
    slug: 'direct',
    name: `${brandName} (site oficial)`,
    kind: 'direct',
    sort_order: 0,
    color: '#2a78d6',
    patterns: [...new Set([...extra, ...DIRECT_GENERIC_PATTERNS])]
  }
}

/**
 * Lista completa de canais padrao para provisionar um tenant do vertical:
 * o 'direct' da marca + os concorrentes do vertical.
 */
export function defaultChannelsFor (verticalKey, { brandName, brandPatterns = [] } = {}) {
  const v = getVertical(verticalKey)
  if (!v) return []
  return [directChannelFor(brandName || 'Marca', brandPatterns), ...v.competitors]
}

export function defaultTargetsFor (verticalKey) {
  return getVertical(verticalKey)?.defaultTargets ?? []
}
