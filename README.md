# Poseidon Planning Poker

Planning Poker em **horas** para o time: o facilitador cria uma sala pelo nome, cada pessoa vota em segredo e os valores só aparecem quando ele revela. Há média, mediana, menor e maior voto, backlog por sala e resumo exportável em CSV.

- Front-end estático (`index.html`, `app.js`, `config.js`), publicado no GitHub Pages.
- Banco e tempo real no Supabase (plano gratuito atende um time).
- Os votos dos outros ficam invisíveis até a revelação **no próprio banco** (política RLS em `supabase/schema.sql`), não só na tela.

## Colocar no ar (cerca de 15 minutos)

### 1. Criar o projeto no Supabase
1. Crie uma conta em supabase.com e clique em **New project**. Guarde a senha do banco em local seguro (você não vai precisar dela no código).
2. No projeto, abra **SQL Editor** → **New query**, cole o conteúdo de `supabase/schema.sql` e clique em **Run**. Deve aparecer "Success".

### 2. Ativar o login anônimo
O time entra só com o nome, sem cadastro. Para isso o Supabase cria uma identidade anônima por navegador.
1. Vá em **Authentication** → **Sign In / Providers**.
2. Ative **Allow anonymous sign-ins** e salve.

### 3. Copiar a URL e a chave para o config.js
1. Em **Project Settings** → **API** (ou **API Keys**), copie a **Project URL** e a chave **anon / publishable**.
2. No GitHub, abra o arquivo `config.js`, clique no lápis (editar), cole os dois valores entre as aspas e clique em **Commit changes**.
3. Use somente a chave `anon` / `publishable`. **Nunca** cole a `service_role`.

### 4. Publicar no GitHub Pages
1. No repositório, vá em **Settings** → **Pages**.
2. Em **Source**, escolha **Deploy from a branch**. Em **Branch**, escolha `main` e a pasta `/ (root)`. Clique em **Save**.
3. Em 1 a 2 minutos o endereço aparece na mesma tela: `https://SEU-USUARIO.github.io/poseidon/`.

### 5. Usar
- O facilitador abre o endereço, digita o nome, escolhe **Criar sala** e dá um nome (por exemplo `Sprint 42`).
- Ele cola a lista de cards em **Backlog → Importar lista**. O primeiro entra em votação.
- O time abre o mesmo endereço, vai em **Entrar em uma sala** e digita o nome da sala.

## Limites conhecidos
- **Facilitador é por navegador.** A identidade é anônima e fica guardada no navegador. Se o facilitador limpar os dados do site ou trocar de navegador, perde o controle daquela sala. Crie outra sala nesse caso.
- **Quem fecha a aba continua na mesa** até clicar em **Sair** ou ser removido pelo facilitador (botão "remover" no cartão).
- **Salas não expiram.** Para limpar, apague as linhas da tabela `rooms` no Supabase (Table Editor); membros e votos somem junto.
- **Plano gratuito do Supabase** pausa o projeto após cerca de uma semana sem uso. Basta reativar no painel.
- O nome da sala funciona como a "senha" de entrada: quem souber o nome entra. Use nomes não óbvios se isso importar.
