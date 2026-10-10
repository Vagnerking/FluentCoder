import assert from "node:assert/strict";
import test from "node:test";
import { findTestMethods, RUN_TEST_COMMAND_ID } from "./testCodeLens.ts";

test("detecta xUnit [Fact] com FQN namespace.classe.metodo", () => {
  const src = `
namespace My.Tests
{
    public class CalcTests
    {
        [Fact]
        public void Soma_DoisMaisDois_Da4()
        {
            Assert.Equal(4, 2 + 2);
        }
    }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].methodName, "Soma_DoisMaisDois_Da4");
  assert.equal(
    methods[0].fullyQualifiedName,
    "My.Tests.CalcTests.Soma_DoisMaisDois_Da4"
  );
});

test("detecta xUnit [Theory] com argumentos", () => {
  const src = `
namespace T;
public class X {
    [Theory(DisplayName = "casos")]
    public void Casos(int a) { }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].fullyQualifiedName, "T.X.Casos");
});

test("detecta NUnit [Test] e [TestCase]", () => {
  const src = `
namespace N;
public class Suite {
    [Test]
    public void Um() { }

    [TestCase(1)]
    [TestCase(2)]
    public void Dois(int v) { }
}`;
  const methods = findTestMethods(src);
  assert.deepEqual(
    methods.map((m) => m.methodName),
    ["Um", "Dois"]
  );
  assert.equal(methods[1].fullyQualifiedName, "N.Suite.Dois");
});

test("detecta MSTest [TestMethod]", () => {
  const src = `
namespace M;
public class T {
    [TestMethod]
    public void Verifica() { }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].fullyQualifiedName, "M.T.Verifica");
});

test("aceita atributo qualificado [Xunit.Fact]", () => {
  const src = `
namespace Q;
public class C {
    [Xunit.Fact]
    public void Qualificado() { }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].fullyQualifiedName, "Q.C.Qualificado");
});

test("aceita múltiplos atributos na mesma linha [Fact, Trait(...)]", () => {
  const src = `
namespace G;
public class C {
    [Fact, Trait("cat", "unit")]
    public void Agrupado() { }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].fullyQualifiedName, "G.C.Agrupado");
});

test("suporta namespace file-scoped (namespace X;)", () => {
  const src = `
namespace File.Scoped;

public class C {
    [Fact]
    public void M() { }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].fullyQualifiedName, "File.Scoped.C.M");
});

test("suporta namespace em bloco", () => {
  const src = `
namespace Block.Ns
{
    public class C
    {
        [Fact]
        public void M() { }
    }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].fullyQualifiedName, "Block.Ns.C.M");
});

test("suporta classe aninhada no FQN", () => {
  const src = `
namespace Nest;
public class Outer {
    public class Inner {
        [Fact]
        public void Deep() { }
    }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].fullyQualifiedName, "Nest.Outer.Inner.Deep");
});

test("método sem atributo de teste não aparece", () => {
  const src = `
namespace S;
public class C {
    [Fact]
    public void EhTeste() { }

    public void NaoEhTeste() { }

    [Obsolete]
    public void TambemNao() { }
}`;
  const methods = findTestMethods(src);
  assert.deepEqual(
    methods.map((m) => m.methodName),
    ["EhTeste"]
  );
});

test("atributo em linha separada do método é detectado", () => {
  const src = `
namespace L;
public class C {
    [Fact]

    public async Task Async_Espacado()
    {
        await Task.CompletedTask;
    }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].methodName, "Async_Espacado");
  assert.equal(methods[0].fullyQualifiedName, "L.C.Async_Espacado");
});

test("comentários // e /* */ não confundem o scanner", () => {
  const src = `
namespace Cmt;
public class C {
    // [Fact] isto é só um comentário, não deve virar teste
    public void Comentado() { }

    /* [Fact]
       public void Bloco() { } */

    [Fact] // roda este
    public void Real() { }
}`;
  const methods = findTestMethods(src);
  assert.deepEqual(
    methods.map((m) => m.methodName),
    ["Real"]
  );
  assert.equal(methods[0].fullyQualifiedName, "Cmt.C.Real");
});

test("[Fact] dentro de string não vira teste", () => {
  const src = `
namespace Str;
public class C {
    [Fact]
    public void Real() {
        var s = "[Fact] public void Fake() { }";
        var v = @"outro [Test] void Fake2() {";
    }
}`;
  const methods = findTestMethods(src);
  assert.deepEqual(
    methods.map((m) => m.methodName),
    ["Real"]
  );
});

test("chaves dentro de string não desalinham o escopo (FQN correto)", () => {
  const src = `
namespace Br;
public class C {
    [Fact]
    public void A() {
        var s = "aqui tem { chaves } soltas";
    }

    [Fact]
    public void B() { }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 2);
  assert.equal(methods[0].fullyQualifiedName, "Br.C.A");
  assert.equal(methods[1].fullyQualifiedName, "Br.C.B");
});

test("sem namespace nem classe emite ao menos o nome do método", () => {
  const src = `
[Fact]
public void Solto() { }`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].methodName, "Solto");
  assert.equal(methods[0].fullyQualifiedName, "Solto");
});

test("line é 1-based e aponta a assinatura do método", () => {
  const src = [
    "namespace N;", // 1
    "public class C {", // 2
    "    [Fact]", // 3
    "    public void M() { }", // 4
    "}", // 5
  ].join("\n");
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].line, 4);
});

test("record class também abre escopo de tipo", () => {
  const src = `
namespace R;
public record class C {
    [Fact]
    public void M() { }
}`;
  const methods = findTestMethods(src);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].fullyQualifiedName, "R.C.M");
});

test("expõe o id de comando esperado pelo caller", () => {
  assert.equal(RUN_TEST_COMMAND_ID, "fluentcoder.runTest");
});
