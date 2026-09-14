// Garante que todo telefone salvo no banco segue o mesmo formato (55 + DDD + numero,
// só dígitos), não importa se veio do agendamento público (já formatado) ou do
// cadastro manual do gestor (ex: "(88) 99999-9999"). Isso evita cadastrar o mesmo
// cliente duas vezes só porque o telefone foi digitado de um jeito diferente.
function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  let digits = String(rawPhone).replace(/\D/g, '');

  // Já veio com o 55 na frente e tamanho de DDI+DDD+numero (12 ou 13 dígitos)
  if (digits.length >= 12 && digits.startsWith('55')) return digits;

  // DDD + numero (10 ou 11 dígitos) sem o 55 -> adiciona
  if (digits.length === 10 || digits.length === 11) return '55' + digits;

  return digits;
}

module.exports = { normalizePhone };
