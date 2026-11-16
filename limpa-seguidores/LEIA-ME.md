# Limpa Seguidores

Extensão para Chrome ou Edge no computador. Ela mostra seus seguidores do Instagram **um por um**
e remove quem você quiser, como contas fake, com uma tecla.

- Funciona com qualquer conta: ela usa a conta que estiver logada no navegador.
- Nada sai do seu computador. Não há servidor, cadastro nem coleta de dados.
- Ela só clica nos botões do próprio site do Instagram, como você faria à mão.

---

## 1. Instalar (uma vez)

1. Extraia o `.zip` numa pasta que você não vá apagar, por exemplo em Documentos.
2. No Chrome, abra `chrome://extensions` (no Edge: `edge://extensions`).
3. Ative o **Modo do desenvolvedor**, no canto superior direito.
4. Clique em **Carregar sem compactação** e escolha a pasta `limpa-seguidores`.
5. Abra o https://www.instagram.com já logado na sua conta.
6. Clique no botão azul **Revisar seguidores**, no canto superior direito.

Se o navegador avisar que bloqueou uma janela, permita **pop-ups** para o instagram.com.

## 2. Carregar seus seguidores (recomendado)

O jeito mais seguro é usar o arquivo oficial que o próprio Instagram gera para você. Assim a
extensão não precisa consultar sua lista no Instagram, o que evita bloqueios temporários.

1. No Instagram: **Configurações → Central de Contas → Suas informações e permissões →
   Baixar suas informações**.
2. Escolha só **Seguidores e seguindo**, formato **HTML** ou **JSON**, e no período escolha
   **"Desde o início"**.
3. Quando o Instagram avisar que o arquivo está pronto, baixe e extraia o `.zip`.
4. No painel da extensão, clique em **Usar arquivos baixados do Instagram** e selecione juntos,
   na pasta `followers_and_following`, os arquivos `followers_1` e `following`. Se houver
   `followers_2`, `followers_3`..., selecione também.
5. Confira se os números que aparecem batem com os do seu perfil.

Se escolher outro período no download, o arquivo vem só com uma parte dos seguidores.

Sem os arquivos, a extensão também funciona: ela pede a lista direto ao Instagram. Só que gasta
consultas, e o Instagram pode limitar a conta por um tempo.

## 3. Usar

| Tecla | O que faz |
|---|---|
| **→** | Remove a pessoa dos seus seguidores. Ela não é avisada. |
| **↑** | Mantém e vai para o próximo. |
| **←** | Volta para o anterior. |
| **P** | Abre o perfil da pessoa numa janela ao lado. |
| **Esc** | Fecha o painel. |

Na primeira remoção abre uma **janela auxiliar** com a sua lista de seguidores. A extensão busca a
pessoa ali e clica em **Remover**. Deixe essa janela aberta enquanto usa; ela pode ficar atrás das
outras. Na primeira vez, a extensão também pode pedir o seu @.

**Opções do painel:**
- **Mostrar só quem eu não sigo:** pula quem você segue.
- **Buscar os números de cada perfil:** mostra posts, seguidores e seguindo, mas gasta 1 a 2
  consultas por pessoa. Vem desligada.
- **Ao remover, também deixar de seguir:** se você segue a pessoa, deixa de seguir junto. Vem ligada.
- **Abrir o perfil de cada pessoa numa janela ao lado:** a janela troca de perfil a cada pessoa.
  Clique de volta no painel para as teclas funcionarem.

A extensão lembra quem você já revisou, então dá para parar e continuar outro dia.
**Recomeçar do zero** apaga esse histórico.

## 4. Cuidados com a conta

- **Vá devagar.** Comece com 30 a 50 remoções por dia. A extensão espera alguns segundos entre
  cada remoção e sugere uma pausa a cada 50. Não tente acelerar.
- Se aparecer um aviso de limite, **pare até o dia seguinte**. Durante 6 horas a extensão não
  faz nenhuma consulta, para não piorar o bloqueio.
- Se o Instagram pedir para confirmar sua identidade ou falar em "atividade incomum", pare
  por alguns dias.
- Usar ferramentas assim vai contra as regras de uso do Instagram. Use por sua conta e risco.
- Se o Instagram mudar o site, a extensão pode parar de funcionar até ser atualizada.

## Problemas comuns

- **O botão azul não aparece:** recarregue a página do Instagram. Se instalou ou atualizou a
  extensão agora, clique no ↻ dela em `chrome://extensions` antes.
- **A lista de seguidores não abre sozinha na janela auxiliar:** clique em "seguidores" você mesmo,
  e a extensão continua dali.
- **"Não achei @fulano na sua lista":** a pessoa provavelmente já não te segue. Clique em **Manter**
  para pular.
