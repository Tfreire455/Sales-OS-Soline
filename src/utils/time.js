import { config } from '../config/settings.js';

// Helper privado para pegar a hora atual em SP (retorna objeto Date ajustado ou inteiros)
const getHoraBrasil = () => {
    const agora = new Date();
    // Formata para obter a string de hora no fuso de SP
    const horaString = agora.toLocaleTimeString('pt-BR', { 
        timeZone: 'America/Sao_Paulo', 
        hour12: false,
        hour: '2-digit', 
        minute: '2-digit'
    });
    
    const [horas, minutos] = horaString.split(':').map(Number);
    return { horas, minutos, agoraObjeto: agora };
};

export const verificarHorarioComercial = () => {
    const { horas } = getHoraBrasil();
    
    // Debug simples para garantir que está pegando o horário certo
    // console.log(`⏰ Hora Check BR: ${horas}h`); 

    if (horas >= config.HORARIO.INICIO && horas < config.HORARIO.FIM) {
        return true; // Loja Aberta
    }
    return false; // Loja Fechada
};

export const calcularTempoAteAcordar = () => {
    const { horas, minutos } = getHoraBrasil();
    
    let msParaDormir = 0;
    const msHora = 60 * 60 * 1000;
    const msMinuto = 60 * 1000;

    // Cenário 1: Já passou do horário (ex: 22:30, abre as 08:00)
    // Precisa dormir o resto da noite + a madrugada
    if (horas >= config.HORARIO.FIM) {
        const horasRestantesHoje = 24 - horas;
        const horasAteAbrir = config.HORARIO.INICIO;
        
        // Soma horas totais e subtrai os minutos que já passaram na hora atual
        msParaDormir = ((horasRestantesHoje + horasAteAbrir) * msHora) - (minutos * msMinuto);
    } 
    // Cenário 2: É madrugada antes de abrir (ex: 04:15, abre as 08:00)
    else if (horas < config.HORARIO.INICIO) {
        const horasFaltantes = config.HORARIO.INICIO - horas;
        
        // Subtrai os minutos atuais
        msParaDormir = (horasFaltantes * msHora) - (minutos * msMinuto);
    }

    // Adiciona 1 segundo de margem de segurança para não acordar 23:59:59
    return msParaDormir + 1000; 
};