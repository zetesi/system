const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// ROTA RAIZ - OBRIGATÓRIA!
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===================== BANCO DE DADOS =====================

const DATA_FILE = path.join(__dirname, 'data', 'database.json');

// Garantir que a pasta data existe
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
            { id: 'admin', password: 'admin123', role: 'master', creditos: 9999, comissao: 0, ref: '', logged: false },
            { id: 'zts', password: 'zts123', role: 'admin', creditos: 5000, comissao: 0, ref: '', logged: false },
            { id: 'teste', password: 'teste123', role: 'user', creditos: 100, comissao: 0, ref: '', logged: false }
        ],
        messages: [
            { user: 'SISTEMA', text: '◈ Sistema ZTS online! Bem-vindo!', time: Date.now(), role: 'master', tipo: 'texto' }
        ],
        indicacoes: [],
        codigos: [],
        codigosUsados: [],
        audioFile: null,
        audioFileName: null,
        multiplier: 1,
        recargas: [],
        usuariosOnline: {}
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

// Carregar dados
let db = loadData();

// ===================== API ROTAS =====================

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

// Adicionar créditos
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

// Obter dados do usuário
app.get('/api/user/:id', (req, res) => {
    const user = db.users.find(u => u.id === req.params.id);
    if (user) {
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
    } else {
        res.json({ success: false, error: 'Usuário não encontrado' });
    }
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

// ===================== SOCKET.IO (CHAT) =====================

io.on('connection', (socket) => {
    console.log('🔗 Usuário conectado:', socket.id);
    
    // Enviar histórico
    socket.emit('historico', db.messages);
    
    // Enviar usuários online
    const onlineUsers = Object.keys(db.usuariosOnline);
    io.emit('usuarios_online', onlineUsers);
    
    // Receber mensagem
    socket.on('nova_mensagem', (data) => {
        const msg = {
            ...data,
            time: Date.now(),
            id: Date.now().toString(36)
        };
        
        db.messages.push(msg);
        if (db.messages.length > 200) {
            db.messages = db.messages.slice(-200);
        }
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
    console.log(`🌐 Acesse: http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════');
    console.log('👥 Usuários:', db.users.length);
    console.log('💬 Mensagens:', db.messages.length);
    console.log('═══════════════════════════════════════════');
});
