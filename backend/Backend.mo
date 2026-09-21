import Array "mo:core/Array";
import Time "mo:core/Time";
persistent actor {
  type Todo = {
    id : Nat;
    text : Text;
    completed : Bool;
    timestamp : Int;
  };

  var todos : [Todo] = [];
  var nextId : Nat = 0;

  public query func getTodos() : async [Todo] {
    todos
  };

  public func addTodo(text : Text) : async Todo {
    let todo : Todo = {
      id = nextId;
      text = text;
      completed = false;
      timestamp = Time.now();
    };

    nextId += 1;
    todos := Array.concat<Todo>(todos, [todo]);
    todo
  };

  public func toggleTodo(id : Nat) : async Bool {
    var found = false;
    todos := Array.map<Todo, Todo>(
      todos,
      func(todo : Todo) : Todo {
        if (todo.id == id) {
          found := true;
          {
            id = todo.id;
            text = todo.text;
            completed = not todo.completed;
            timestamp = todo.timestamp;
          }
        } else {
          todo
        }
      }
    );
    found
  };

  public func deleteTodo(id : Nat) : async Bool {
    let oldLength = todos.size();
    todos := Array.filter<Todo>(
      todos,
      func(todo : Todo) : Bool {
        todo.id != id
      }
    );
    todos.size() < oldLength
  };
  public func editTodo(id : Nat, newText : Text) : async Bool {
    var found = false;
    todos := Array.map<Todo, Todo>(
      todos,
      func(todo : Todo) : Todo {
        if (todo.id == id) {
          found := true;
          {
            id = todo.id;
            text = newText;
            completed = todo.completed;
            timestamp = todo.timestamp;
          }
        } else {
          todo
        }
      }
    );
    found
  };
};