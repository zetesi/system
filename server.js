const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// SDK do Mercado Pago
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rota raiz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===================== MERCADO PAGO - SUAS CREDENCIAIS =====================

const MP_ACCESS_TOKEN = 'APP_USR-5823435670170048-030708-318fc7a16e0012b0abac1ffca6045011-1907448126';
const MP_PUBLIC_KEY = 'APP_USR-81d4c82a-9e37-4141-b926-c499b6a71c19';
const MP_WEBHOOK_URL = 'https://dharmawhellchk.onrender.com/webhook';

// Inicializar cliente do Mercado Pago
const client = new MercadoPagoConfig({
    accessToken: MP_ACCESS_TOKEN
});

const payment = new Payment(client);

console.log('💰 Mercado Pago configurado com sucesso!');

// ===================== BANCO DE DADOS =====================

const DATA_FILE = path.join(__dirname, 'data', 'database.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE);
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('Erro ao carregar dados:', e);
    }
    return getDefaultData();
}

function getDefaultData() {
    return {
        users: [
            { id: 'Zts', password: 'admin123', role: 'master', creditos: 9999, comissao: 0, ref: '', logged: false },
            { id: 'zts', password: 'zts123', role: 'admin', creditos: 5000, comissao: 0, ref: '', logged: false },
            { id: 'teste', password: 'teste123', role: 'user', creditos: 100, comissao: 0, ref: '', logged: false }
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
        pagamentosPendentes: {}
    };
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

// ===================== MERCADO PAGO - CRIAR PIX =====================

app.post('/api/create-pix', async (req, res) => {
    try {
        const { user, valor, creditos } = req.body;
        
        if (!user || !valor || !creditos) {
            return res.json({ success: false, error: 'Dados incompletos' });
        }
        
        const userData = db.users.find(u => u.id === user);
        if (!userData) {
            return res.json({ success: false, error: 'Usuário não encontrado' });
        }
        
        // Criar pagamento PIX no Mercado Pago
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
        
        console.log('📡 Criando PIX para:', user, 'Valor:', valor);
        
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
        
        const qrCode = response.point_of_interaction?.transaction_data?.qr_code || '';
        const qrCodeBase64 = response.point_of_interaction?.transaction_data?.qr_code_base64 || '';
        const copyPaste = response.point_of_interaction?.transaction_data?.ticket_url || '';
        
        console.log('✅ PIX criado! ID:', response.id);
        
        return res.json({
            success: true,
            payment_id: response.id,
            qr_code: qrCode,
            qr_code_base64: qrCodeBase64,
            copy_paste: copyPaste,
            status: response.status
        });
        
    } catch (error) {
        console.error('❌ Erro ao criar PIX:', error);
        return res.json({ success: false, error: error.message });
    }
});

// ===================== MERCADO PAGO - WEBHOOK =====================

app.post('/webhook', async (req, res) => {
    try {
        const rawBody = req.body;
        const { type, data, id } = rawBody;
        
        console.log('📨 Webhook recebido:', type, id || data?.id);
        
        if (type === 'payment' || type === 'payment.created') {
            const paymentId = data?.id || id;
            
            if (!paymentId) {
                return res.status(200).send('OK');
            }
            
            const pending = db.pagamentosPendentes[paymentId];
            
            if (pending && pending.status === 'pending') {
                try {
                    const paymentData = await payment.get({ id: paymentId });
                    
                    console.log('📊 Status do pagamento:', paymentData?.status);
                    
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
                    console.error('Erro ao consultar pagamento:', error);
                }
            }
        }
        
        res.status(200).send('OK');
        
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        res.status(200).send('OK');
    }
});

// ===================== CONSULTAR STATUS DO PAGAMENTO =====================

app.get('/api/payment-status/:id', async (req, res) => {
    try {
        const paymentId = req.params.id;
        const pending = db.pagamentosPendentes[paymentId];
        
        if (!pending) {
            return res.json({ success: false, error: 'Pagamento não encontrado' });
        }
        
        if (pending.status === 'pending') {
            try {
                const paymentData = await payment.get({ id: paymentId });
                if (paymentData && paymentData.status === 'approved') {
                    pending.status = 'approved';
                    saveData(db);
                    
                    // Adicionar créditos se ainda não foi feito
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
                }
            } catch (e) {
                console.error('Erro ao consultar status:', e);
            }
        }
        
        return res.json({
            success: true,
            status: pending.status,
            user: pending.user,
            creditos: pending.creditos
        });
        
    } catch (error) {
        console.error('Erro ao consultar pagamento:', error);
        return res.json({ success: false, error: error.message });
    }
});

// ===================== ROTAS EXISTENTES =====================

// Login
app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    const found = db.users.find(u => u.id === user && u.password === pass);
    
    if (found) {
        found.logged = true;
        db.usuariosOnline[user] = Date.now();
        saveData(db);
        res.json({ 
            success: true, 
            user: { 
                id: found.id, 
                role: found.role, 
                creditos: found.creditos,
                comissao: found.comissao,
                ref: found.ref
            } 
        });
    } else {
        res.json({ success: false, error: 'Usuário ou senha inválidos' });
    }
});

// Cadastro
app.post('/api/register', (req, res) => {
    const { user, pass, ref } = req.body;
    
    if (db.users.find(u => u.id === user)) {
        res.json({ success: false, error: 'Usuário já existe' });
        return;
    }
    
    const novo = { 
        id: user, 
        password: pass, 
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
                indicado: user,
                data: new Date().toISOString(),
                status: 'pendente',
                bonus: 0
            });
        }
    }
    
    saveData(db);
    res.json({ success: true, message: 'Cadastro realizado!' });
});

// Logout
app.post('/api/logout', (req, res) => {
    const { user } = req.body;
    const found = db.users.find(u => u.id === user);
    if (found) {
        found.logged = false;
        delete db.usuariosOnline[user];
        saveData(db);
    }
    res.json({ success: true });
});

// Adicionar créditos (admin)
app.post('/api/addcredits', (req, res) => {
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
app.post('/api/resgatar', (req, res) => {
    const { user, codigo } = req.body;
    
    if (db.codigosUsados.includes(codigo)) {
        res.json({ success: false, error: 'Código já utilizado' });
        return;
    }
    
    const codeObj = db.codigos.find(c => c.codigo === codigo);
    if (!codeObj) {
        res.json({ success: false, error: 'Código inválido' });
        return;
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
app.post('/api/gerarcodigo', (req, res) => {
    const { adminUser, creditos, prefix } = req.body;
    const admin = db.users.find(u => u.id === adminUser);
    
    if (!admin || (admin.role !== 'admin' && admin.role !== 'master')) {
        res.json({ success: false, error: 'Apenas administradores' });
        return;
    }
    
    const codigo = (prefix || 'ZTS') + '-' + Math.random().toString(36).substring(2,8).toUpperCase();
    db.codigos.push({ codigo, creditos: creditos || 50, criado: Date.now() });
    saveData(db);
    res.json({ success: true, codigo, creditos: creditos || 50 });
});

// Listar usuários (admin)
app.get('/api/users/:adminUser', (req, res) => {
    const admin = db.users.find(u => u.id === req.params.adminUser);
    if (!admin || (admin.role !== 'admin' && admin.role !== 'master')) {
        res.json({ success: false, error: 'Acesso negado' });
        return;
    }
    
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
app.post('/api/promote', (req, res) => {
    const { adminUser, targetUser } = req.body;
    const admin = db.users.find(u => u.id === adminUser);
    
    if (!admin || (admin.role !== 'admin' && admin.role !== 'master')) {
        res.json({ success: false, error: 'Acesso negado' });
        return;
    }
    
    const target = db.users.find(u => u.id === targetUser);
    if (!target || target.role === 'master') {
        res.json({ success: false, error: 'Não é possível promover' });
        return;
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
app.post('/api/deleteuser', (req, res) => {
    const { adminUser, targetUser } = req.body;
    const admin = db.users.find(u => u.id === adminUser);
    
    if (!admin || (admin.role !== 'admin' && admin.role !== 'master')) {
        res.json({ success: false, error: 'Acesso negado' });
        return;
    }
    
    if (targetUser === adminUser) {
        res.json({ success: false, error: 'Não pode remover a si mesmo' });
        return;
    }
    
    db.users = db.users.filter(u => u.id !== targetUser);
    saveData(db);
    res.json({ success: true });
});

// Definir multiplicador (admin)
app.post('/api/multiplier', (req, res) => {
    const { adminUser, value } = req.body;
    const admin = db.users.find(u => u.id === adminUser);
    
    if (!admin || (admin.role !== 'admin' && admin.role !== 'master')) {
        res.json({ success: false, error: 'Apenas administradores' });
        return;
    }
    
    db.multiplier = value;
    saveData(db);
    res.json({ success: true, multiplier: value });
});

// Resetar sistema (admin)
app.post('/api/reset', (req, res) => {
    const { adminUser } = req.body;
    const admin = db.users.find(u => u.id === adminUser);
    
    if (!admin || admin.role !== 'master') {
        res.json({ success: false, error: 'Apenas MASTER' });
        return;
    }
    
    const master = db.users.find(u => u.role === 'master');
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
        const msg = { ...data, time: Date.now(), id: Date.now().toString(36) };
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
    console.log(`💰 Mercado Pago: ✅ CONFIGURADO`);
    console.log(`🔗 Webhook URL: ${MP_WEBHOOK_URL}`);
    console.log(`👥 Usuários: ${db.users.length}`);
    console.log(`💬 Mensagens: ${db.messages.length}`);
    console.log('═══════════════════════════════════════════');
});
