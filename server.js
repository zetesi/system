const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

// SDK do Mercado Pago
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// ===================== SEGURANÇA =====================

// Helmet para proteção de headers
app.use(helmet());

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // 100 requisições por IP
    message: { error: 'Muitas requisições, tente novamente mais tarde.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Limites específicos
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5, // 5 tentativas de login por 15 minutos
    message: { error: 'Muitas tentativas de login, tente novamente em 15 minutos.' }
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 3, // 3 cadastros por hora
    message: { error: 'Limite de cadastros excedido.' }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rota raiz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===================== MERCADO PAGO =====================

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY;
const MP_WEBHOOK_URL = process.env.MP_WEBHOOK_URL || 'https://dharmawhellchk.onrender.com/webhook';
const JWT_SECRET = process.env.JWT_SECRET || 'zts_mahoraga_secret_key_2024_ultra_seguro';
const SALT_ROUNDS = 10;

const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const payment = new Payment(client);

console.log('💰 Mercado Pago configurado com sucesso!');

// ===================== BANCO DE DADOS =====================

const DATA_FILE = path.join(__dirname, 'data', 'database.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

function getDefaultData() {
    return {
        users: [
            { id: 'admin', password: '$2b$10$SgxkBEMjZ9.bWjfY.Zd1a.mK3X3IhJfQaJqTQaJqTQaJqTQaJqTQ', role: 'master', creditos: 9999, comissao: 0, ref: '', logged: false },
            { id: 'zts', password: '$2b$10$SgxkBEMjZ9.bWjfY.Zd1a.mK3X3IhJfQaJqTQaJqTQaJqTQaJqTQ', role: 'admin', creditos: 5000, comissao: 0, ref: '', logged: false },
            { id: 'teste', password: '$2b$10$SgxkBEMjZ9.bWjfY.Zd1a.mK3X3IhJfQaJqTQaJqTQaJqTQaJqTQ', role: 'user', creditos: 100, comissao: 0, ref: '', logged: false }
        ],
        messages: [
            { user: 'SISTEMA', text: '◈ Sistema ZTS online!', time: Date.now(), role: 'master', tipo: 'texto' }
        ],
        indicacoes: [],
        codigos: [],
        codigosUsados: [],
        audioFile: null,
        audioFileName: null,
        multiplier: 1,
        recargas: [],
        pagamentosPendentes: {},
        usuariosOnline: {}
    };
}

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE);
            const parsed = JSON.parse(raw);
            if (!parsed.pagamentosPendentes) parsed.pagamentosPendentes = {};
            if (!parsed.usuariosOnline) parsed.usuariosOnline = {};
            if (!parsed.recargas) parsed.recargas = [];
            if (!parsed.codigos) parsed.codigos = [];
            if (!parsed.codigosUsados) parsed.codigosUsados = [];
            if (!parsed.indicacoes) parsed.indicacoes = [];
            return parsed;
        }
    } catch (e) {
        console.error('Erro ao carregar dados:', e);
    }
    return getDefaultData();
}

function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        console.error('Erro ao salvar dados:', e);
        return false;
    }
}

let db = loadData();

// ===================== MIDDLEWARE DE AUTENTICAÇÃO =====================

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'Token não fornecido' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.users.find(u => u.id === decoded.id);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Usuário não encontrado' });
        }
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, error: 'Token inválido ou expirado' });
    }
}

function adminMiddleware(req, res, next) {
    if (req.user.role !== 'admin' && req.user.role !== 'master') {
        return res.status(403).json({ success: false, error: 'Acesso negado. Necessário privilégios de administrador.' });
    }
    next();
}

function masterMiddleware(req, res, next) {
    if (req.user.role !== 'master') {
        return res.status(403).json({ success: false, error: 'Acesso negado. Necessário privilégios de master.' });
    }
    next();
}

// ===================== ROTAS PÚBLICAS =====================

// Login - com rate limit
app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { user, pass } = req.body;
        
        if (!user || !pass) {
            return res.json({ success: false, error: 'Usuário e senha são obrigatórios' });
        }
        
        const found = db.users.find(u => u.id === user);
        if (!found) {
            return res.json({ success: false, error: 'Usuário ou senha inválidos' });
        }
        
        // Verificar senha com bcrypt
        const validPassword = await bcrypt.compare(pass, found.password);
        if (!validPassword) {
            return res.json({ success: false, error: 'Usuário ou senha inválidos' });
        }
        
        // Gerar token JWT
        const token = jwt.sign(
            { id: found.id, role: found.role },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        found.logged = true;
        db.usuariosOnline[user] = Date.now();
        saveData(db);
        
        res.json({
            success: true,
            token,
            user: {
                id: found.id,
                role: found.role,
                creditos: found.creditos,
                comissao: found.comissao,
                ref: found.ref
            }
        });
    } catch (error) {
        console.error('Erro no login:', error);
        res.json({ success: false, error: 'Erro interno do servidor' });
    }
});

// Cadastro - com rate limit
app.post('/api/register', registerLimiter, async (req, res) => {
    try {
        const { user, pass, ref } = req.body;
        
        if (!user || !pass) {
            return res.json({ success: false, error: 'Usuário e senha são obrigatórios' });
        }
        
        if (user.length < 3) {
            return res.json({ success: false, error: 'Usuário deve ter pelo menos 3 caracteres' });
        }
        
        if (pass.length < 6) {
            return res.json({ success: false, error: 'Senha deve ter pelo menos 6 caracteres' });
        }
        
        // Sanitizar
        const sanitizedUser = user.replace(/[<>]/g, '').trim();
        
        if (db.users.find(u => u.id === sanitizedUser)) {
            return res.json({ success: false, error: 'Usuário já existe' });
        }
        
        // Hash da senha
        const hashedPassword = await bcrypt.hash(pass, SALT_ROUNDS);
        
        const novo = {
            id: sanitizedUser,
            password: hashedPassword,
            role: 'user',
            creditos: 0,
            comissao: 0,
            ref: ref || '',
            logged: false
        };
        db.users.push(novo);
        
        if (ref) {
            const afiliado = db.users.find(u => u.id === ref);
            if (afiliado) {
                db.indicacoes.push({
                    afiliado: ref,
                    indicado: sanitizedUser,
                    data: new Date().toISOString(),
                    status: 'pendente',
                    bonus: 0
                });
            }
        }
        
        saveData(db);
        res.json({ success: true, message: 'Cadastro realizado!' });
    } catch (error) {
        console.error('Erro no cadastro:', error);
        res.json({ success: false, error: 'Erro interno do servidor' });
    }
});

// ===================== ROTAS PROTEGIDAS =====================

// Logout
app.post('/api/logout', authMiddleware, (req, res) => {
    const found = db.users.find(u => u.id === req.user.id);
    if (found) {
        found.logged = false;
        delete db.usuariosOnline[req.user.id];
        saveData(db);
    }
    res.json({ success: true });
});

// Obter dados do usuário
app.get('/api/user/:id', authMiddleware, (req, res) => {
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) {
        return res.json({ success: false, error: 'Usuário não encontrado' });
    }
    res.json({
        success: true,
        user: {
            id: user.id,
            role: user.role,
            creditos: user.creditos,
            comissao: user.comissao,
            ref: user.ref
        }
    });
});

// ===================== MERCADO PAGO - ROTAS PROTEGIDAS =====================

// Criar PIX
app.post('/api/create-pix', authMiddleware, async (req, res) => {
    try {
        const { valor, creditos } = req.body;
        const user = req.user.id;
        
        if (!valor || !creditos) {
            return res.json({ success: false, error: 'Dados incompletos' });
        }
        
        const request = {
            body: {
                transaction_amount: parseFloat(valor),
                description: `Recarga de créditos - ${user}`,
                payment_method_id: 'pix',
                payer: {
                    email: `${user}@zts-system.com`,
                    first_name: user,
                },
                notification_url: MP_WEBHOOK_URL,
                external_reference: `recarga_${user}_${Date.now()}`
            }
        };
        
        const response = await payment.create(request);
        
        if (!response || !response.id) {
            return res.json({ success: false, error: 'Erro ao criar PIX' });
        }
        
        db.pagamentosPendentes[response.id] = {
            user: user,
            creditos: creditos,
            valor: valor,
            status: 'pending',
            criado: Date.now()
        };
        saveData(db);
        
        res.json({
            success: true,
            payment_id: response.id,
            qr_code: response.point_of_interaction?.transaction_data?.qr_code || '',
            qr_code_base64: response.point_of_interaction?.transaction_data?.qr_code_base64 || '',
            copy_paste: response.point_of_interaction?.transaction_data?.ticket_url || '',
            status: response.status
        });
    } catch (error) {
        console.error('Erro ao criar PIX:', error);
        res.json({ success: false, error: error.message });
    }
});

// Consultar status do pagamento
app.get('/api/payment-status/:id', authMiddleware, async (req, res) => {
    try {
        const paymentId = req.params.id;
        const pending = db.pagamentosPendentes[paymentId];
        
        if (!pending) {
            return res.json({ success: false, error: 'Pagamento não encontrado' });
        }
        
        // Verificar se o pagamento pertence ao usuário
        if (pending.user !== req.user.id) {
            return res.json({ success: false, error: 'Pagamento não pertence a este usuário' });
        }
        
        if (pending.status === 'pending') {
            try {
                const paymentData = await payment.get({ id: paymentId });
                if (paymentData && paymentData.status === 'approved') {
                    pending.status = 'approved';
                    const user = db.users.find(u => u.id === pending.user);
                    if (user) {
                        const multiplier = db.multiplier || 1;
                        const totalCredito = pending.creditos * multiplier;
                        user.creditos += totalCredito;
                        db.recargas.push({
                            user: pending.user,
                            valor: pending.valor,
                            creditos: totalCredito,
                            data: new Date().toISOString(),
                            payment_id: paymentId,
                            status: 'approved'
                        });
                        saveData(db);
                        io.emit('pagamento_confirmado', {
                            user: pending.user,
                            creditos: totalCredito,
                            payment_id: paymentId
                        });
                    }
                } else if (paymentData && paymentData.status === 'rejected') {
                    pending.status = 'rejected';
                    saveData(db);
                }
            } catch (e) {
                console.error('Erro ao consultar status:', e.message);
            }
        }
        
        res.json({
            success: true,
            status: pending.status,
            user: pending.user,
            creditos: pending.creditos
        });
    } catch (error) {
        console.error('Erro ao consultar pagamento:', error);
        res.json({ success: false, error: error.message });
    }
});

// ===================== WEBHOOK (PÚBLICO) =====================

app.post('/webhook', async (req, res) => {
    try {
        const rawBody = req.body;
        console.log('📨 Webhook recebido:', JSON.stringify(rawBody).substring(0, 500));
        
        if (!rawBody || Object.keys(rawBody).length === 0) {
            console.warn('⚠️ Body vazio recebido');
            return res.status(200).send('OK');
        }
        
        const { type, data, id } = rawBody;
        const paymentId = data?.id || id || rawBody.id;
        
        if (type === 'payment' || type === 'payment.created' || rawBody.action === 'payment.created') {
            if (!paymentId) {
                console.warn('⚠️ Payment ID não encontrado');
                return res.status(200).send('OK');
            }
            
            const pending = db.pagamentosPendentes[paymentId];
            
            if (pending && pending.status === 'pending') {
                try {
                    const paymentData = await payment.get({ id: paymentId });
                    
                    if (paymentData && paymentData.status === 'approved') {
                        const user = db.users.find(u => u.id === pending.user);
                        if (user) {
                            const multiplier = db.multiplier || 1;
                            const totalCredito = pending.creditos * multiplier;
                            user.creditos += totalCredito;
                            db.recargas.push({
                                user: pending.user,
                                valor: pending.valor,
                                creditos: totalCredito,
                                data: new Date().toISOString(),
                                payment_id: paymentId,
                                status: 'approved'
                            });
                            pending.status = 'approved';
                            saveData(db);
                            io.emit('pagamento_confirmado', {
                                user: pending.user,
                                creditos: totalCredito,
                                payment_id: paymentId
                            });
                            console.log(`✅ Pagamento ${paymentId} aprovado para ${pending.user}: +${totalCredito} créditos`);
                        }
                    } else if (paymentData && paymentData.status === 'rejected') {
                        pending.status = 'rejected';
                        saveData(db);
                        console.log(`❌ Pagamento ${paymentId} rejeitado`);
                    }
                } catch (error) {
                    console.error('❌ Erro ao consultar pagamento:', error.message);
                }
            }
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Erro no webhook:', error.message);
        res.status(200).send('OK');
    }
});

// ===================== ROTAS DE ADMIN =====================

// Adicionar créditos (admin)
app.post('/api/addcredits', authMiddleware, adminMiddleware, (req, res) => {
    const { user, credits } = req.body;
    const found = db.users.find(u => u.id === user);
    if (found) {
        found.creditos += credits;
        saveData(db);
        res.json({ success: true, creditos: found.creditos });
    } else {
        res.json({ success: false, error: 'Usuário não encontrado' });
    }
});

// Resgatar código
app.post('/api/resgatar', authMiddleware, (req, res) => {
    const { codigo } = req.body;
    const user = req.user.id;
    
    if (db.codigosUsados.includes(codigo)) {
        return res.json({ success: false, error: 'Código já utilizado' });
    }
    
    const codeObj = db.codigos.find(c => c.codigo === codigo);
    if (!codeObj) {
        return res.json({ success: false, error: 'Código inválido' });
    }
    
    const found = db.users.find(u => u.id === user);
    if (found) {
        found.creditos += codeObj.creditos;
        db.codigosUsados.push(codigo);
        saveData(db);
        res.json({ success: true, creditos: found.creditos, ganhos: codeObj.creditos });
    } else {
        res.json({ success: false, error: 'Usuário não encontrado' });
    }
});

// Gerar código (admin)
app.post('/api/gerarcodigo', authMiddleware, adminMiddleware, (req, res) => {
    const { creditos, prefix } = req.body;
    const codigo = (prefix || 'ZTS') + '-' + Math.random().toString(36).substring(2,8).toUpperCase();
    db.codigos.push({ codigo, creditos: creditos || 50, criado: Date.now() });
    saveData(db);
    res.json({ success: true, codigo, creditos: creditos || 50 });
});

// Listar usuários (admin)
app.get('/api/users', authMiddleware, adminMiddleware, (req, res) => {
    const users = db.users.map(u => ({
        id: u.id,
        role: u.role,
        creditos: u.creditos,
        comissao: u.comissao,
        logged: u.logged || false
    }));
    res.json({ success: true, users });
});

// Promover usuário (admin)
app.post('/api/promote', authMiddleware, adminMiddleware, (req, res) => {
    const { targetUser } = req.body;
    const target = db.users.find(u => u.id === targetUser);
    if (!target || target.role === 'master') {
        return res.json({ success: false, error: 'Não é possível promover este usuário' });
    }
    const roles = ['user', 'afiliado', 'admin'];
    const idx = roles.indexOf(target.role);
    if (idx < roles.length - 1) {
        target.role = roles[idx + 1];
        saveData(db);
        res.json({ success: true, newRole: target.role });
    } else {
        res.json({ success: false, error: 'Já está no nível máximo' });
    }
});

// Remover usuário (admin)
app.post('/api/deleteuser', authMiddleware, adminMiddleware, (req, res) => {
    const { targetUser } = req.body;
    if (targetUser === req.user.id) {
        return res.json({ success: false, error: 'Não pode remover a si mesmo' });
    }
    db.users = db.users.filter(u => u.id !== targetUser);
    saveData(db);
    res.json({ success: true });
});

// Definir multiplicador (admin)
app.post('/api/multiplier', authMiddleware, adminMiddleware, (req, res) => {
    const { value } = req.body;
    db.multiplier = value;
    saveData(db);
    res.json({ success: true, multiplier: value });
});

// Resetar sistema (master)
app.post('/api/reset', authMiddleware, masterMiddleware, (req, res) => {
    const master = db.users.find(u => u.id === req.user.id);
    db = getDefaultData();
    if (master) {
        db.users = db.users.map(u => u.role === 'master' ? master : u);
    }
    saveData(db);
    res.json({ success: true });
});

// ===================== SOCKET.IO =====================

io.on('connection', (socket) => {
    console.log('🔗 Usuário conectado:', socket.id);
    
    socket.emit('historico', db.messages);
    io.emit('usuarios_online', Object.keys(db.usuariosOnline));
    
    socket.on('nova_mensagem', (data) => {
        // Validar mensagem
        if (!data.text || data.text.length > 500) return;
        // Sanitizar
        const cleanText = data.text.replace(/[<>]/g, '').trim();
        if (!cleanText) return;
        
        const msg = { 
            ...data, 
            text: cleanText,
            time: Date.now(), 
            id: Date.now().toString(36) 
        };
        db.messages.push(msg);
        if (db.messages.length > 200) db.messages = db.messages.slice(-200);
        saveData(db);
        io.emit('mensagem_recebida', msg);
    });
    
    socket.on('disconnect', () => {
        console.log('🔌 Usuário desconectado:', socket.id);
        for (const [user, time] of Object.entries(db.usuariosOnline)) {
            if (Date.now() - time > 60000) {
                const userObj = db.users.find(u => u.id === user);
                if (userObj) userObj.logged = false;
                delete db.usuariosOnline[user];
            }
        }
        saveData(db);
        io.emit('usuarios_online', Object.keys(db.usuariosOnline));
    });
});

// ===================== INICIAR SERVIDOR =====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════');
    console.log('◈ SISTEMA ZTS - MAHORAGA DHARMA WHEEL ◈');
    console.log('═══════════════════════════════════════════');
    console.log(`📱 Servidor rodando na porta: ${PORT}`);
    console.log(`🔒 Segurança: ✅ ATIVADA (bcrypt + JWT + Rate Limit)`);
    console.log(`💰 Mercado Pago: ✅ CONFIGURADO`);
    console.log(`🔗 Webhook URL: ${MP_WEBHOOK_URL}`);
    console.log(`👥 Usuários: ${db.users.length}`);
    console.log(`💬 Mensagens: ${db.messages.length}`);
    console.log('═══════════════════════════════════════════');
});
