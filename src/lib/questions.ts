export type Question = {
  id: string;
  section: 'personal' | 'empresarial';
  title: string;
  help?: string;
};
export const questions: Question[] = [
  {
    id: 'A1',
    section: 'personal',
    title: '¿Tienes testamento actualizado?',
    help: 'No más de 5 años.',
  },
  {
    id: 'A2',
    section: 'personal',
    title: '¿Tienes por escrito el “Detalle de todo tu patrimonio”?',
    help: 'Escrituras en regla, pago de impuestos al día, listado de propiedades, cuentas bancarias, fondos, etc.',
  },
  {
    id: 'A3',
    section: 'personal',
    title: '¿Tus familiares tienen acceso al “Detalle de todo tu patrimonio”?',
    help: '¿Saben dónde está? ¿Tienen copia digital o por escrito?',
  },
  {
    id: 'A4',
    section: 'personal',
    title: '¿Tu familia sabe cómo debe actuar en caso de que fallezcas hoy?',
    help: 'Plan de acción: personas a quienes llamar (agente de seguros, notario, abogados, amigos, etc.).',
  },
  {
    id: 'A5',
    section: 'personal',
    title: '¿Sabes cuánto vale todo tu patrimonio personal?',
    help: 'Valor de casas, autos, cuentas bancarias, acciones, joyas, deudas, etc.',
  },
  { id: 'A6', section: 'personal', title: '¿Tienes seguro de vida?' },
  {
    id: 'A7',
    section: 'personal',
    title: '¿Tu familia conoce las condiciones y detalles de tu seguro de vida?',
    help: 'Compañía de seguros, suma asegurada, nombre del agente, condiciones especiales, etc.',
  },
  {
    id: 'A8',
    section: 'personal',
    title:
      '¿La suma asegurada es suficiente para mantener el nivel de vida de tu familia en caso de fallecimiento?',
    help: 'Por lo menos, cubrir el costo de vida anual por los años que faltan para que el hijo menor sea financieramente independiente.',
  },
  {
    id: 'A9',
    section: 'personal',
    title: '¿Todas tus propiedades están en orden?',
    help: 'Escrituras en regla, pago de impuestos al día, etc.',
  },
  {
    id: 'A10',
    section: 'personal',
    title: 'En caso de tener familia (cónyuge e hijos menores), ¿cuentas con albacea y/o tutor?',
    help: '¿Saben lo que deben hacer, están capacitados y tienen copia del testamento?',
  },
  {
    id: 'B1',
    section: 'empresarial',
    title: '¿Tu familia conoce la composición accionaria de tu(s) empresa(s)?',
    help: 'Quiénes son los socios, su porcentaje de participación y quién tiene poderes.',
  },
  {
    id: 'B2',
    section: 'empresarial',
    title: '¿Sabes cuánto vale tu patrimonio empresarial (acciones)?',
    help: 'Valor de acciones, activos fijos, marca, etc.',
  },
  {
    id: 'B3',
    section: 'empresarial',
    title: '¿Las actas de asamblea de la empresa están actualizadas?',
    help: 'Actualizadas y protocolizadas ante fedatario público.',
  },
  {
    id: 'B4',
    section: 'empresarial',
    title: '¿Tienes establecido un protocolo a seguir en caso del fallecimiento de un socio?',
    help: 'Venta de la empresa, pago de acciones o incorporación de su familia al Consejo u operación.',
  },
  {
    id: 'B5',
    section: 'empresarial',
    title: '¿Tienes establecido un protocolo a seguir en caso de que TÚ fallezcas?',
    help: 'Pago de acciones a tu familia o ingreso al Consejo u operación de la empresa.',
  },
  {
    id: 'B6',
    section: 'empresarial',
    title: '¿Tienes estipulado qué deseas hacer con tus acciones en caso de fallecimiento?',
    help: '¿Se venden, regalan, traspasan o donan? ¿A quién?',
  },
  {
    id: 'B7',
    section: 'empresarial',
    title: '¿Tienes un plan de sucesión dentro de la empresa?',
    help: 'Preparación de los hijos o contratación de dirección general externa.',
  },
  {
    id: 'B8',
    section: 'empresarial',
    title: '¿Tienes implementado gobierno corporativo dentro de tu empresa?',
    help: '¿El Consejo es formal, según mejores prácticas, o solo de papel?',
  },
  {
    id: 'B9',
    section: 'empresarial',
    title: '¿Tienes establecido el protocolo familiar?',
    help: '¿Es formal y se aplica, o solo está en papel?',
  },
  {
    id: 'B10',
    section: 'empresarial',
    title: '¿Tienes establecido un Family Office?',
    help: '¿Es formal o solo está en papel?',
  },
];
export const questionIds = questions.map((q) => q.id);
