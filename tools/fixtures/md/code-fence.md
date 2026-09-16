```js
const a = 1
function f() {
  return a
}
```

```
无语言围栏
```

~~~python
def f():
    return 1
~~~

````text
四反引号里可以出现三个反引号：
```
````

```json
{ "a": 1 }
```

内容末尾带一个空行（用户在块尾敲过回车）——必须在收尾围栏前多留一行，
否则 CommonMark 会把那个换行当成「最后一行的行终止符」，重新打开就少一行：

```js
let b = 2

```

